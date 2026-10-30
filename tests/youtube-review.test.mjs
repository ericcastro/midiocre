import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../app/lib/youtubeReview.ts', import.meta.url),'utf8');
const { outputText } = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}});
const {matchNotes,mergeNotes,transportPosition,auditionEvents} = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const n=(id,start,end,pitch=60)=>({id,start,end,pitch,instrument:'acoustic_piano',boundary:false});
test('tolerant matching separates timing, pitch, additions and removals',()=>{
 const matches=matchNotes([n('a',1,2),n('b',3,4,64),n('c',6,7,40)],[n('x',1.06,2.1),n('y',3.01,4,65),n('z',8,9,72)]);
 assert.deepEqual(matches.map(m=>m.kind),['timing','pitch','removed','added']);
});
test('repeated/chord ambiguities are not silently paired',()=>{
 const matches=matchNotes([n('a',1,2),n('b',1.02,2.02)],[n('x',1.01,2.01)]);
 assert.ok(matches.every(m=>m.kind==='ambiguous'));
 assert.ok(matches.every(m=>!m.before||!m.after));
});
test('merge is explicit and requires the same pitch and instrument',()=>{
 const notes=[n('a',1,1.5),n('b',1.7,2),n('c',1,2,64)];
 const merged=mergeNotes(notes,new Set(['a','b']));
 assert.equal(merged.length,2);assert.equal(merged.find(n=>n.id==='a').end,2);
 assert.throws(()=>mergeNotes(notes,new Set(['a','c'])));
 assert.equal(notes.length,3);
});
test('shared clock retains position over hundreds of loops and a new seek',()=>{
 const loop={start:2.25,end:5.75};
 assert.equal(transportPosition(3,2.75,loop,10),2.25);
 assert.equal(transportPosition(3,2.75+3.5*500+.125,loop,10),2.375);
 assert.equal(transportPosition(4,0,loop,10),4);
});
test('seek resumes sustained notes and loop boundaries retrigger exactly once',()=>{
 const notes=[n('a',1,4),n('b',4.5,6)];
 const loop={start:2,end:5};
 const events=auditionEvents(notes,3,0,5.1,loop,10);
 assert.deepEqual(events,[{pitch:60,at:0,duration:1},{pitch:60,at:1.5,duration:.5},{pitch:60,at:2,duration:2},{pitch:60,at:4.5,duration:.5},{pitch:60,at:5,duration:2}]);
 const left=auditionEvents(notes,3,0,2,loop,10),right=auditionEvents(notes,3,2,5.1,loop,10);
 assert.deepEqual([...left,...right],events);
});
test('non-looping playback clips notes at source end',()=>{
 assert.deepEqual(auditionEvents([n('a',9,12)],8,0,4,null,10),[{pitch:60,at:1,duration:1}]);
 assert.equal(transportPosition(8,20,null,10),10);
});

test('actual transport anchors original and piano together after seek, loop and version switch', async () => {
 const transportSource = fs.readFileSync(new URL('../app/lib/reviewTransport.ts', import.meta.url),'utf8');
 const compiled = ts.transpileModule(transportSource,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 const dependency = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
 const {ReviewTransport}=await import(`data:text/javascript;base64,${Buffer.from(compiled.replace('"./youtubeReview"',JSON.stringify(dependency))).toString('base64')}`);
 const sources=[];
 const param=()=>({value:1,setValueAtTime(){},linearRampToValueAtTime(){}});
 class FakeContext {
  static instance;
  currentTime=10;destination={};
  constructor(){FakeContext.instance=this;}
  async decodeAudioData(){return {duration:12};}
  createGain(){return {gain:param(),connect(){},disconnect(){}};}
  createBufferSource(){const source={playbackRate:param(),connect(){},disconnect(){},start(at,offset){this.at=at;this.offset=offset;},stop(end){this.end=end;}};sources.push(source);return source;}
  async resume(){} async close(){}
 }
 const originals={AudioContext:globalThis.AudioContext,fetch:globalThis.fetch,setInterval:globalThis.setInterval,clearInterval:globalThis.clearInterval};
 let tick;
 try {
  globalThis.AudioContext=FakeContext;
  globalThis.fetch=async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(0)});
  globalThis.setInterval=fn=>{tick=fn;return 1;};globalThis.clearInterval=()=>{};
  const t=new ReviewTransport();
  t.seek(3);assert.equal(t.position,3); // seeking works before audio has loaded
  await t.load('/fixture.wav');
  const context=FakeContext.instance;
  t.configure([n('held',1,6)],{start:2,end:5});
  t.seek(3);await t.play();
  assert.equal(sources[0].offset,3);
  assert.equal(sources[0].at,sources[1].at);
  assert.equal(sources[0].loopStart,2);assert.equal(sources[0].loopEnd,5);
  assert.equal(sources[1].end, sources[0].at+2);
  context.currentTime=10.525;tick(); // background delay recovers by reanchoring both
  const p=t.position;
  assert.ok(Math.abs(p-3.5)<1e-8);
  assert.equal(sources.at(-1).at,sources.at(-2).at);
  t.configure([n('changed',1,6,62)],{start:2,end:5});
  assert.ok(Math.abs(t.position-p)<1e-8);
  assert.equal(sources.at(-1).at,sources.at(-2).at);
  const beforeSeek=sources.length;
  t.seek(4.9);
  const audio=sources[beforeSeek],piano=sources[beforeSeek+1];
  assert.equal(audio.offset,4.9);assert.equal(audio.at,piano.at);
  context.currentTime=audio.at+.11;tick();
  assert.ok(Math.abs(t.position-2.01)<1e-8);
  assert.ok(Math.abs(sources.at(-1).at-(audio.at+.1))<1e-8);
  t.pause();assert.equal(t.playing,false);t.dispose();
 } finally {Object.assign(globalThis,originals);}
});
