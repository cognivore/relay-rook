"use strict";

// Runs in the chosen Lichess tab. Uses its existing login; no cookie/token export.
async function lichessStep(action, payload) {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => !!el?.getClientRects().length;
  const find = selector => [...document.querySelectorAll(selector)].find(visible);
  const label = name => {
    const el = [...document.querySelectorAll('label')].find(e => visible(e) && e.textContent.trim() === name);
    const input = el && document.getElementById(el.htmlFor);
    if (!input) throw Error(`Lichess field missing: ${name}`);
    return input;
  };
  const set = (el, value) => {
    el.value = value;
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
  };
  const choose = (name, title) => {
    const el = label(name), option = [...el.options].find(o => o.textContent.trim() === title);
    if (!option) throw Error(`Lichess option missing: ${title}`);
    set(el, option.value);
  };
  const button = name => {
    const el = [...document.querySelectorAll('button')].find(e=>visible(e) && (e.textContent.trim()===name || e.title===name || e.getAttribute('aria-label')===name));
    if (!el) throw Error(`Lichess control missing: ${name}`);
    return el;
  };
  const wait = async test => {
    for (let i=0;i<100;i++) { const result=test(); if(result) return result; await pause(200); }
    throw Error('Lichess did not reach the expected state within 20 seconds.');
  };
  try {
    if (location.origin !== payload.origin) throw Error('Lichess instance changed; import stopped.');
    if (action === 'open') { button('Create study').click(); return {ok:true}; }
    if (action === 'configure') {
      if (!find('dialog')) { await wait(()=>find('button[title="Edit study"]')); button('Edit study').click(); }
      await wait(()=>find('dialog input'));
      set(label('Name'), payload.name);
      choose('Visibility', 'Invite only');
      choose('Allow cloning', 'Only me');
      choose('Share & export', 'Only me');
      const creating=[...document.querySelectorAll('dialog h2')].some(e=>e.textContent.trim()==='Create study');
      button(creating?'Start':'Save').click();
      await wait(()=>creating?document.querySelector('#chapter-name'):!find('dialog'));
      return {ok:true, url:location.origin+location.pathname};
    }
    if (action === 'privacy') {
      if (find('dialog')) button('Close').click();
      button('Edit study').click();
      await wait(()=>[...document.querySelectorAll('label')].some(e=>visible(e) && e.textContent.trim()==='Visibility'));
      const value = label('Visibility').selectedOptions[0].textContent.trim();
      if (value !== 'Invite only') throw Error('The study is not private. No book was uploaded.');
      button('Close').click();
      return {ok:true};
    }
    if (action === 'import') {
      if (!/^\/study\/[A-Za-z0-9]{8}(?:\/[A-Za-z0-9]{8})?$/.test(location.pathname)) throw Error('Not on a Lichess study.');
      const id=location.pathname.split('/')[2];
      if (id!==payload.id) throw Error('Study ID mismatch.');
      const response = await fetch(`/study/${id}/import-pgn?sri=relayrook`, {
        method:'POST', credentials:'same-origin', redirect:'error',
        headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest'},
        body:new URLSearchParams({pgn:payload.pgn,initial:'true',sticky:'false',isDefaultName:'true',orientation:'auto',mode:'normal'}),
        signal:AbortSignal.timeout(60000),
      });
      if (!response.ok) throw Error(`Lichess import failed (${response.status}): ${(await response.text()).replace(/<[^>]*>/g,' ').slice(0,300)}`);
      return {ok:true};
    }
    if (action === 'export') {
      const response=await fetch(`/study/${payload.id}.pgn`, {credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(60000)});
      if(!response.ok) throw Error(`Lichess verification failed (${response.status}).`);
      const pgn=await response.text();
      if(!pgn.startsWith('[')) throw Error('Lichess returned a page instead of the study PGN. Check your login.');
      return {ok:true,pgn};
    }
    throw Error('Unknown Lichess action.');
  } catch(error) { return {ok:false,error:error.message}; }
}
