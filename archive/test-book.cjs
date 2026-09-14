const assert = require('node:assert/strict');
const Book = require('../extension/archive/book.js');
const root='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const lesson={course:'A "quoted" course',url:'https://www.chessable.com/variation/1/',title:'First lesson',chapter:'Introduction',chapterOrder:1,order:1,id:'1',initialFen:root,tokens:[
  {kind:'comment',text:'Before the move.\n\nKeep both paragraphs & <literal text>.'},
  {kind:'move',number:'1.',san:'e4',annotation:'!',fen:'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'},
  {kind:'open'}, {kind:'move',number:'1.',san:'d4',annotation:'',fen:'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1'}, {kind:'close'},
  {kind:'comment',text:'After the move.'},
]};
const pgn=Book.pgn(lesson);
assert.match(pgn,/\[Event "A \\"quoted\\" course"\]/);
assert.match(pgn,/1\. e4! \( 1\. d4 \)/);
assert.deepEqual(Book.signature(pgn),Book.signature(pgn.replace('e4!','e4 $1').replace('\n\nKeep',' Keep')));
assert.notDeepEqual(Book.signature(pgn),Book.signature(pgn.replace('After the move.','Different commentary.')));
assert.equal(Book.signature(pgn+'\n'+pgn).length,2);
const nullLesson={...lesson,tokens:[lesson.tokens[0],lesson.tokens[1],{kind:'move',number:'1...',san:'--',annotation:'',fen:'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2'},{kind:'comment',text:'After the pass.'},{kind:'move',number:'2.',san:'d4',annotation:'',fen:'rnbqkbnr/pppppppp/8/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq d3 0 2'}]};
const sections=Book.forLichess([nullLesson]);
assert.equal(sections.length,2);
assert.equal(sections[1].initialFen,nullLesson.tokens[2].fen);
assert.equal(sections.flatMap(s=>s.tokens).filter(t=>t.kind==='comment').length,2);
assert.equal(sections.flatMap(s=>s.tokens).some(t=>t.san==='--'),false);
assert.equal(Book.signature(sections.map(Book.pgn).join('\n')).length,2);
const informational=Book.forLichess([{...lesson,tokens:[lesson.tokens[0],{kind:'move',number:'1.',san:'--',annotation:'',fen:root.replace(' w ',' b ')}]}]);
assert.equal(informational.length,1);assert.match(Book.pgn(informational[0]),/Keep both paragraphs/);
assert.match(Book.html({title:'Test'},[lesson]),/&lt;literal text&gt;/);
assert.throws(()=>Book.pgn({...lesson,tokens:[{kind:'comment',text:'bad } comment'}]}),/closing brace/);
assert.throws(()=>Book.pgn({...lesson,tokens:[{kind:'close'}]}),/Unbalanced/);
assert.throws(()=>Book.fen('8/8/8/8/8/8/8/9 w - - 0 1'),/Invalid/);
assert.equal(Book.instance('https://lichess.org'),'https://lichess.org/');
assert.equal(Book.instance('http://localhost:9663'),'http://localhost:9663/');
assert.equal(Book.permission('http://localhost:9663/'),'http://localhost/*');
for(const bad of ['https://evil.test/user','https://user:password@lichess.org','javascript:alert(1)','http://remote.test/','https://lichess.org/?token=secret'])assert.throws(()=>Book.instance(bad));
console.log('Book checks passed: PGN comments, branches, annotations, round-trip comparison, HTML escaping and instance boundaries.');
