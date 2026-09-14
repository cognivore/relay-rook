// Small DOM doubles exercise the shipped message handler, not a copied parser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const Book = require('../extension/archive/book.js');
const source = fs.readFileSync(path.join(__dirname, '../extension/src/archive-scan.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(__dirname, '../extension/src/content.js'), 'utf8');
const origin = 'https://www.chessable.com';
function anchor(href, text, video = false) {
  return { href: origin + href, textContent: text, firstElementChild: { textContent: text },
    querySelector: selector => selector.startsWith('.title') ? { textContent: text } : video ? {} : null };
}
function fixture(pathname, selectors = {}, hash = '#relay-rook-archive=test') {
  let observer;
  const handlers=[], pageEvents={}, sent=[];
  const timers = new Set();
  const lookup = selector => typeof selectors[selector] === 'function' ? selectors[selector]() : selectors[selector];
  class MouseEvent {constructor(type, options) {this.type=type;Object.assign(this,options);}}
  const context = { URL, Map, Set, Error, Book, MouseEvent, PointerEvent:MouseEvent, location: { origin, pathname, hash },
    setTimeout: (fn, ms) => {
      const timer={ms}; timers.add(timer);
      (ms===8000 ? setImmediate : queueMicrotask)(()=>{if(timers.delete(timer))fn();});
      return timer;
    },
    clearTimeout: timer => timers.delete(timer),
    setInterval: () => {},
    MutationObserver: class {
      constructor(callback) {this.callback=callback;observer=this;}
      observe() {this.connected=true;}
      disconnect() {this.connected=false;}
    },
    window: { scrollTo() {} },
    document: {readyState:'loading',addEventListener:(name,fn)=>{pageEvents[name]=fn;},body: { scrollHeight: 100 }, querySelector: selector => lookup(selector) || (selector.startsWith('a.bookTitle,') ? {} : null),
      querySelectorAll: selector => lookup(selector) || [] },
    chrome: { runtime: {sendMessage:msg=>{sent.push(msg);return Promise.resolve();}, onMessage: { addListener: fn => {handlers.push(fn);} } } } };
  vm.createContext(context);
  vm.runInContext(source, context);
  vm.runInContext(contentSource, context);
  return { context, sent, pageEvents, bridge:handlers[1], scan: (mode, lesson) => new Promise(resolve => handlers[0]({ type: 'ARCHIVE_SCAN', mode, lesson, token:hash }, {}, resolve)),
    mutate: () => {if(observer?.connected)observer.callback();},
    observing: () => observer?.connected,
    handler: (...args) => handlers[0](...args) };
}
// Shapes from the signed-in /variation/48641668/ HTML: commentary, a null
// placeholder, two backward controls, selected move and the readonly FEN input.
function lessonFixture(onRewind) {
  const initial='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const after=initial.replace(' w ', ' b ');
  const move={nodeType:1, childNodes:[{nodeType:3,textContent:'--'}], dataset:{san:'--',move:'1.',fen:after},
    matches:s=>s==='[data-san]',querySelector:()=>null};
  const comment={nodeType:1,tagName:'SPAN',innerHTML:'Exact introduction.',
    matches:s=>s==='.commentInVariation',childNodes:[{nodeType:3,textContent:'Exact introduction.'}]};
  const root={childNodes:[comment,move],querySelectorAll:()=>[move]};
  const state={events:[],rewind:{disabled:false,
    click(){assert.fail('Chessable rewind does not handle click; it handles mousedown.');},
    getBoundingClientRect:()=>({left:0,top:0,width:40,height:40}),
    dispatchEvent(event){
      state.events.push(event.type);
      if(event.type==='mousedown' && event.bubbles && event.button===0)onRewind(state,page);
      return true;
    }
  },previous:{disabled:false},selected:move,input:{value:after}};
  const page=fixture('/variation/42/',{
    'a[href]':[anchor('/course/258968/1/?o=42','1. Introduction')],
    '.board-btns__btn .fa-fast-backward':()=>({closest:()=>state.rewind}),
    '.board-btns__btn .fa-chevron-left':()=>({closest:()=>state.previous}),
    '#inputFEN':state.input, '#theOpeningMoves':root,
    '#theOpeningMoves .textMoveHighlighted':()=>state.selected,
    '#theOpeningMoves [data-san][data-move]':()=>root.querySelectorAll()[0],
  });
  const meta={id:'42',courseId:'258968',course:'Preventing Blunders in Chess',chapterId:'1',chapter:'1. Introduction',chapterOrder:1,order:1,title:'Aim of the Course',url:origin+'/variation/42/'};
  return {state,page,initial,move,root,scan:()=>page.scan('lesson',meta)};
}
(async () => {
  const chapters = fixture('/course/123333', { 'a[href]': [
    anchor('/course/123333/0', '1. Introduction', true),
    anchor('/course/123333/10', '2. Skills to be Trained', true),
    anchor('/course/123333/0', 'Duplicate'), anchor('/course/999/1', 'Unrelated'),
  ] });
  const result = await chapters.scan('chapters');
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.chapters, c => [c.id, c.title, c.order]), [
    ['0', '1. Introduction', 1], ['10', '2. Skills to be Trained', 2],
  ]);
  const filter={checked:true,click(){this.checked=!this.checked;}};
  const lessonPage=fixture('/course/123333/0',{
    'label[title="Filter by video"] input':filter,
    'a[href]':[anchor('/variation/42/','Introduction'),anchor('/variation/42/','Duplicate'),anchor('/variation/43/','Exercise')]
  });
  const found=await lessonPage.scan('lessons');
  assert.equal(found.lessons.length,2);
  assert.equal(found.lessons[0].id,'42');
  assert.equal(filter.checked,true,'Restore the video filter');
  const trigger = { textContent: 'Active', click() {} };
  const option = label => ({ textContent: label, getClientRects: () => [{}], click: () => { trigger.textContent = label; } });
  const library = fixture('/', {
    '[data-testid="filter-by-trigger"]': trigger,
    '[role="option"]': [option('All'), option('Active')],
    'a.bookTitle': [anchor('/course/123333', 'Calculation'), anchor('/course/123333', 'Calculation'), anchor('/course/351885', '1.g3')],
  });
  const courses = await library.scan('library');
  assert.equal(courses.courses.length, 2);
  assert.equal(trigger.textContent, 'Active', 'Restore the original library filter');
  library.context.location.hash = '';
  assert.equal((await library.scan('library')).ok,true,'Keep the scan identity after Chessable rewrites the hash');
  library.pageEvents.DOMContentLoaded();
  library.bridge({type:'RECONNECT'},{},()=>assert.fail('Do not connect a scan tab to the physical board'));
  assert.equal(library.sent.length,0,'Hash rewriting must not enable board sync');
  const normal=fixture('/',{},'');
  normal.context.location.hash='#relay-rook-archive=late';
  assert.equal(normal.handler({type:'ARCHIVE_SCAN',mode:'library',token:normal.context.location.hash},{},()=>{}),false,'Normal tabs cannot become scan tabs after loading');
  let mismatch;
  library.handler({type:'ARCHIVE_SCAN',token:'#relay-rook-archive=another',mode:'library'},{},response=>{mismatch=response;});
  assert.equal(mismatch.ok,false,'Reject a request intended for another scan page');
  const missing = await fixture('/course/123333').scan('chapters');
  assert.equal(missing.ok, false, 'Never report an empty/inaccessible course as scanned');
  const replaced=lessonFixture((state,page)=>queueMicrotask(()=>{
    state.rewind={disabled:true};state.previous={disabled:true};state.selected=null;
    page.mutate(); // Controls update before the FEN: do not save the old board.
    queueMicrotask(()=>{state.input.value=replaced.initial;page.mutate();});
  }));
  const oldButton=replaced.state.rewind;
  const saved=await replaced.scan();
  assert.equal(saved.ok,true,saved.error);
  assert.equal(oldButton.disabled,false,'The detached control never changes');
  assert.equal(saved.lesson.initialFen,replaced.initial,'Wait for the starting FEN too');
  assert.deepEqual(replaced.state.events,['pointerdown','mousedown','pointerup','mouseup','click'],'Exercise the actual shared event helper');
  assert.equal(saved.lesson.tokens[0].text,'Exact introduction.');
  assert.match(saved.lesson.pgn,/\[ChapterName "1.1 Aim of the Course"\]/);
  assert.equal(replaced.page.observing(),false,'Disconnect after success');
  const already=lessonFixture(()=>assert.fail('Do not click a disabled rewind control'));
  already.state.rewind.disabled=already.state.previous.disabled=true;
  already.state.selected=null;already.state.input.value=already.initial;
  assert.equal((await already.scan()).ok,true);
  const stuck=lessonFixture(()=>{});
  const failed=await stuck.scan();
  assert.equal(failed.ok,false);
  assert.match(failed.error,/within 8 seconds.*rewind disabled: false.*FEN:/);
  assert.equal(stuck.page.observing(),false,'Disconnect after failure');
  const staleFen=lessonFixture(state=>{state.rewind.disabled=state.previous.disabled=true;state.selected=null;});
  assert.equal((await staleFen.scan()).ok,false,'Disabled controls cannot validate a post-move FEN');
  const selected=lessonFixture(state=>{state.rewind.disabled=state.previous.disabled=true;state.input.value=selected.initial;});
  assert.equal((await selected.scan()).ok,false,'A selected move cannot be mistaken for the starting position');
  const black=lessonFixture(()=>assert.fail('Black-to-move root is already selected'));
  black.state.rewind.disabled=black.state.previous.disabled=true;black.state.selected=null;
  black.state.input.value='2r3k1/5bqp/8/7B/2r3PQ/5P2/6RK/6R1 b - - 0 1';
  Object.assign(black.move.dataset,{san:'Bxh5',move:'1...',fen:'2r3k1/6qp/8/7b/2r3PQ/5P2/6RK/6R1 w - - 0 2'});
  black.move.childNodes[0].textContent='Bxh5';
  const blackResult=await black.scan();
  assert.equal(blackResult.ok,true,blackResult.error);
  assert.equal(blackResult.lesson.initialFen,black.state.input.value);
  // Live Puzzle 58 has an unnumbered reply and an evaluation in a side line.
  const puzzle=lessonFixture(()=>assert.fail('Puzzle is already at its starting position'));
  puzzle.state.rewind.disabled=puzzle.state.previous.disabled=true;puzzle.state.selected=null;
  puzzle.state.input.value='8/3k4/3b1n2/2p5/3n2pQ/8/5K2/3R4 b - - 0 1';
  const domMove=(san,number,fen,piece,suffix,prefix='')=>({nodeType:1,
    dataset:{san,move:number,fen},matches:s=>s==='[data-san]',childNodes:[
      {nodeType:3,textContent:prefix},
      {nodeType:1,dataset:{piece},matches:s=>s==='[role="img"][data-piece]'},
      {nodeType:3,textContent:suffix}
    ]});
  const puzzleMoves=[
    domMove('Bg3+','1...','8/3k4/5n2/2p5/3n2pQ/6b1/5K2/3R4 w - - 1 2','bishop','g3+'),
    domMove('Kxg3','2.','8/3k4/5n2/2p5/3n2pQ/6K1/8/3R4 b - - 0 2','king','xg3!'),
    domMove('Qxg3',null,'8/3k4/5n2/2p5/3n2p1/6Q1/5K2/3R4 b - - 0 2','queen','xg3??','2.'),
    domMove('Ne4',null,'8/3k4/8/2p5/3nn1p1/6Q1/5K2/3R4 w - - 1 3','knight','e4+!','2...'),
    domMove('Kg2',null,'8/3k4/8/2p5/3nn1p1/6Q1/6K1/3R4 b - - 2 3','king','g2','3.'),
    domMove('Nxg3',null,'8/3k4/8/2p5/3n2p1/6n1/6K1/3R4 w - - 0 4','knight','xg3'),
    domMove('Kxg3',null,'8/3k4/8/2p5/3n2p1/6K1/8/3R4 b - - 0 4','king','xg3=','4.'),
  ];
  puzzle.root.childNodes=[puzzle.root.childNodes[0],...puzzleMoves.slice(0,2),
    {nodeType:1,matches:s=>s==='.commentSubvar',childNodes:puzzleMoves.slice(2)}];
  puzzle.root.querySelectorAll=()=>puzzleMoves;
  const puzzleResult=await puzzle.scan();
  assert.equal(puzzleResult.ok,true,puzzleResult.error);
  assert.match(puzzleResult.lesson.pgn,/1\.\.\. Bg3\+ 2\. Kxg3! \( 2\. Qxg3\?\? 2\.\.\. Ne4\+! 3\. Kg2 3\.\.\. Nxg3 4\. Kxg3 \$10 \)/);
  assert.equal(puzzleResult.lesson.tokens.filter(t=>t.kind==='move').length,7);
  puzzleMoves[5].dataset.san='Nxe3';
  const disagreement=await puzzle.scan();
  assert.equal(disagreement.ok,false,'A genuine notation/data disagreement still fails the entire lesson');
  assert.match(disagreement.error,/Nxg3.*Nxe3/);
  console.log('Scanner checks passed: enumeration, filters, order, scan isolation, rewind states, figurines, unnumbered side moves, evaluations and genuine data mismatches.');
})();
