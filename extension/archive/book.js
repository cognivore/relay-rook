"use strict";

// Pure conversions shared by the scanner, downloaded books and tests.
const Book = (() => {
  const text = value => String(value ?? '').replace(/\u00a0/g, ' ').trim();
  function fen(value) {
    const parts = text(value).split(/\s+/);
    if (parts.length !== 6 || !/^[wb]$/.test(parts[1]) || !/^\d+$/.test(parts[5])) throw Error('Missing or invalid starting FEN.');
    if (parts[0].split('/').length !== 8 || parts[0].split('/').some(rank => [...rank].reduce((n,c) => n + (/[1-8]/.test(c) ? Number(c) : /[prnbqkPRNBQK]/.test(c) ? 1 : 99), 0) !== 8)) throw Error('Invalid board in FEN.');
    return parts.join(' ');
  }
  function tag(key, value) { return `[${key} "${text(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ')}"]`; }
  function comment(value) {
    if (value.includes('}')) throw Error('A commentary contains a closing brace that PGN cannot preserve. The lesson needs review.');
    return `{ ${value} }`;
  }
  function pgn(lesson) {
    let count = 0, depth = 0;
    const combined=lesson.tokens.reduce((result,token)=>{
      if(token.kind==='comment' && result.at(-1)?.kind==='comment')result.at(-1).text+='\n\n'+token.text;
      else result.push({...token});
      return result;
    },[]);
    const moves = combined.map(t => {
      if (t.kind === 'comment') return comment(t.text);
      if (t.kind === 'open') { depth++; return '('; }
      if (t.kind === 'close') { if (--depth < 0) throw Error('Unbalanced variation.'); return ')'; }
      if (t.kind !== 'move' || !/^(?:--|O-O(?:-O)?[+#]?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)$/.test(t.san)) throw Error(`Unsupported move: ${t.san}`);
      if (!/^\d+\.(?:\.\.)?$/.test(t.number)) throw Error('Move number missing.');
      fen(t.fen); count++;
      if (!/^(?:[!?]{1,2})?$/.test(t.annotation)) throw Error(`Unsupported annotation: ${t.annotation}`);
      return `${t.number} ${t.san}${t.annotation}`;
    });
    if (depth || (!count && !lesson.positionOnly)) throw Error('Incomplete move tree.');
    const name = `${lesson.chapterOrder}.${lesson.order} ${lesson.title}`;
    return [tag('Event', lesson.course), tag('Site', lesson.url), tag('Date', '????.??.??'), tag('Round', `${lesson.chapterOrder}.${lesson.order}`), tag('White', '?'), tag('Black', '?'), tag('Result', '*'), tag('ChapterName', name), tag('SetUp', '1'), tag('FEN', fen(lesson.initialFen)), '', moves.join(' ') + ' *', ''].join('\n');
  }
  function instance(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Lichess instance must be an HTTP(S) origin, such as https://lichess.org/ or http://localhost:9663/.');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.hostname.endsWith('.localhost')) throw Error('Use HTTPS for a remote Lichess instance.');
    return url.origin + '/';
  }
  const safeName = value => text(value).replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_').slice(0,100).replace(/[. ]+$/g,'') || 'Book';
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function html(course, lessons) {
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(course.title)}</title><style>body{max-width:850px;margin:40px auto;padding:0 24px;font:18px/1.65 system-ui;background:#faf8f3;color:#242424}a{color:#254d76}article{border-top:1px solid #ccc;margin-top:40px;padding-top:20px}.comment{white-space:pre-wrap}.move{font-weight:bold}code{overflow-wrap:anywhere}nav a{display:block}</style><h1>${escape(course.title)}</h1><p>Archived from your Chessable library. Companion PGN files contain the positions and move trees.</p><nav>${lessons.map(l=>`<a href="#lesson-${l.id}">${escape(l.chapterOrder+'.'+l.order+' '+l.title)}</a>`).join('')}</nav>${lessons.map(l=>`<article id="lesson-${l.id}"><h2>${escape(l.chapter+' · '+l.title)}</h2><a href="${escape(l.url)}">Source lesson</a><p>Starting FEN: <code>${escape(l.initialFen)}</code></p>${l.tokens.map(t=>t.kind==='comment'?`<p class="comment">${escape(t.text)}</p>`:t.kind==='move'?`<span class="move">${escape(t.number+' '+t.san+t.annotation)} </span>`:escape(t.kind==='open'?' ( ':' ) ')).join('')}</article>`).join('')}`;
  }
  function signature(source) {
    return source.trim().split(/\n\s*\n(?=\[)/).map(game => {
      const initial = game.match(/^\[FEN "(.*)"\]$/m)?.[1] || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      const body = game.replace(/^\[[^\n]*\]\s*$/gm,'');
      const nags = {'!':'$1','?':'$2','!!':'$3','??':'$4','!?':'$5','?!':'$6'};
      const tokens = body.match(/\{[^}]*\}|\(|\)|[^\s(){}]+/g) || [], normalized=[];
      for (let token of tokens) {
        if (token.startsWith('{')) { normalized.push(token.replace(/\s+/g,' ').trim()); continue; }
        token=token.replace(/^\d+\.(?:\.\.)?/,'');
        if(!token || ['*','1-0','0-1','1/2-1/2','...'].includes(token)) continue;
        const suffix=token.match(/[!?]+$/)?.[0];
        if(suffix) normalized.push(token.slice(0,-suffix.length),nags[suffix]);
        else normalized.push(token);
      }
      return {fen:fen(initial),tokens:normalized};
    });
  }
  function forLichess(lessons) {
    return lessons.flatMap(lesson => {
      if(!lesson.tokens.some(t=>t.kind==='move' && t.san==='--'))return [lesson];
      const root={fen:lesson.initialFen,comments:[],children:[]}, stack=[];
      let current=root;
      for(const token of lesson.tokens){
        if(token.kind==='comment')current.comments.push(token);
        else if(token.kind==='move'){
          const next={fen:token.fen,move:token,comments:[],children:[],parent:current};
          current.children.push(next);current=next;
        }else if(token.kind==='open'){
          if(!current.parent)throw Error('A variation has no parent position.');
          stack.push(current);current=current.parent;
        }else if(token.kind==='close'){
          if(!stack.length)throw Error('Unbalanced variation.');current=stack.pop();
        }else throw Error('Unsupported move-tree token.');
      }
      if(stack.length)throw Error('Unbalanced variation.');
      const sections=[root];
      function cut(parent){
        parent.children=parent.children.filter(child=>{
          if(child.move.san==='--'){
            // Lichess explicitly rejects null moves. Start a separate chapter at
            // the source's post-null FEN; never invent an opponent move.
            if(child.comments.length || child.children.length)sections.push(child);
            cut(child);return false;
          }
          cut(child);return true;
        });
      }
      cut(root);
      return sections.map((section,index)=>{
        const tokens=[...section.comments];
        function branch(node){tokens.push(node.move,...node.comments);children(node);}
        function children(node){
          const [main,...others]=node.children;if(!main)return;
          tokens.push(main.move,...main.comments);
          for(const other of others){tokens.push({kind:'open'});branch(other);tokens.push({kind:'close'});}
          children(main);
        }
        children(section);
        return {...lesson,initialFen:section.fen,tokens,positionOnly:!tokens.some(t=>t.kind==='move'),
          title:lesson.title+(sections.length>1?` · part ${index+1}/${sections.length}`:''),sourceLessonId:lesson.id};
      });
    });
  }
  const permission = value => { const url=new URL(instance(value)); return `${url.protocol}//${url.hostname}/*`; };
  return {text, fen, pgn, instance, permission, safeName, html, signature, forLichess};
})();
if (typeof module !== 'undefined') module.exports = Book;
