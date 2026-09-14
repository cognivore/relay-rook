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
assert.match(pgn,/1\. e4! \{ After the move\. \} \( 1\. d4 \)/);
assert.equal(lesson.tokens.at(-1).text,'After the move.','Export must not mutate saved tokens');
const nested={...lesson,tokens:[lesson.tokens[1],{kind:'comment',text:'Main before.'},{kind:'open'},lesson.tokens[3],{kind:'comment',text:'Side before.'},{kind:'open'},lesson.tokens[1],{kind:'comment',text:'Nested.'},{kind:'close'},{kind:'comment',text:'Side after.'},{kind:'close'},{kind:'comment',text:'Main after.'}]};
assert.match(Book.pgn(nested),/e4! \{ Main before\.\n\nMain after\. \} \( 1\. d4 \{ Side before\.\n\nSide after\. \} \( 1\. e4! \{ Nested\. \} \) \)/);
assert.equal(nested.tokens[1].text,'Main before.');
assert.deepEqual(Book.signature(pgn),Book.signature(pgn.replace('e4!','e4 $1').replace('\n\nKeep',' Keep')));
assert.notDeepEqual(Book.signature(pgn),Book.signature(pgn.replace('After the move.','Different commentary.')));
assert.equal(Book.signature(pgn+'\n'+pgn).length,2);
// Signed-in Puzzle 58–62 markup: omitted black move numbers, check/mate
// missing from data-san, and evaluation glyphs immediately after the SAN.
for(const [display,san,fen,number,expectedSan,nag] of [
  ['Nxg3','Nxg3','8/3k4/8/2p5/3n2p1/6n1/6K1/3R4 w - - 0 4','3...','Nxg3',''],
  ['Qxf6=','Qxf6','8/ppp1k3/5q2/PP6/K2P4/8/8/3Q4 w - - 0 4','3...','Qxf6',' $10'],
  ['Qxe5-+','Qxe5','8/ppp5/3k4/PP2q3/K2P1r2/8/8/3Q4 w - - 0 3','2...','Qxe5',' $19'],
  ['5.Kg2+-','Kg2','1k6/1pp5/p7/2p5/4nQb1/1P3n2/P5K1/7R b - - 8 5','5.','Kg2',' $18'],
  ['4...Ne3+-+','Ne3','1k6/1pp5/p2n4/2p5/6Q1/1P2n3/P7/5K1R w - - 1 5','4...','Ne3+',' $19'],
  ['Re1=','Re1','6k1/5ppp/b1p1p3/p1P5/P7/3P4/2PB1PPP/1r2R1K1 b - - 2 29','29.','Re1',' $10'],
  ['2.Nd7+-+','Nd7','8/3N4/8/2q1k3/8/p1P5/6B1/2KN4 b - - 2 2','2.','Nd7+',' $19'],
  ['2.Bf1#','Bf1','8/8/5N2/2q5/8/p1Pk4/8/2KN1B2 b - - 2 2','2.','Bf1#',''],
]) {
  const parsed=Book.move(display,{san,fen});
  assert.equal(parsed.number,number,display);assert.equal(parsed.san,expectedSan,display);
  const exported=Book.pgn({...lesson,tokens:[parsed]});
  assert.ok(exported.includes(`${number} ${expectedSan}${nag} *`),display);
  if(nag)assert.notDeepEqual(Book.signature(exported),Book.signature(exported.replace(nag,'')),'Round-trip validation must detect a lost evaluation');
}
const afterE4=lesson.tokens[1].fen;
for(const [glyph,nag] of [['□',7],['∞',13],['⩲',14],['⩱',15],['±',16],['∓',17],['⨀',22],['⟳',32],['↑↑',32],['↑',36],['→',40],['=∞',44],['⇆',132],['⊕',138],['∆',140],['N',146]]) {
  const parsed=Book.move('e4'+glyph,{san:'e4',fen:afterE4});
  assert.ok(Book.pgn({...lesson,tokens:[parsed]}).includes(`e4 $${nag} *`));
}
const promoted=Book.move('1.e8=Q+!',{san:'e8=Q',fen:'4Q2k/8/8/8/8/8/8/K7 b - - 0 1'});
assert.equal(promoted.san,'e8=Q+');assert.equal(promoted.annotation,'!');
const castled=Book.move('1.O-O!?',{san:'O-O',fen:'4k3/8/8/8/8/8/8/5RK1 b - - 1 1'});
assert.equal(castled.san,'O-O');assert.equal(castled.annotation,'!?');
assert.throws(()=>Book.move('d4',{san:'e4',fen:afterE4}),/disagrees/);
assert.throws(()=>Book.move('2.e4',{san:'e4',fen:afterE4}),/Move number/);
assert.throws(()=>Book.move('e4',{san:'e4',move:'1...',fen:afterE4}),/Move number/);
assert.throws(()=>Book.move('e4',{san:'e4',fen:afterE4.replace(' b ',' w ')}),/move counter/);
assert.throws(()=>Book.move('e4[unknown]',{san:'e4',fen:afterE4}),/disagrees/);
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
const range=[{chapterOrder:1},{chapterOrder:3}];
assert.equal(Book.volumeName('Preventing Blunders in Chess',range,1,6),'Preventing Blunders in Chess · Vol 01/06 · Ch 1–3');
assert.equal(Book.volumeName('Calculation',[{chapterOrder:12}],2,2),'Calculation · Vol 02/02 · Ch 12');
assert.equal(Book.volumeName('A'.repeat(150),range,1,6).length,100);
assert.match(Book.volumeName('A'.repeat(150),range,1,6),/ · Vol 01\/06 · Ch 1–3$/);
assert.throws(()=>Book.volumeName('Course',[],1,1),/Cannot name/);
assert.throws(()=>Book.volumeName('Course',range,2,1),/Cannot name/);
for(const bad of ['https://evil.test/user','https://user:password@lichess.org','javascript:alert(1)','http://remote.test/','https://lichess.org/?token=secret'])assert.throws(()=>Book.instance(bad));
console.log('Book checks passed: PGN comments, branches, annotations, round-trip comparison, HTML escaping and instance boundaries.');
