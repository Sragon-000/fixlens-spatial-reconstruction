import test from 'node:test';
import assert from 'node:assert/strict';
import {AssemblyEngine} from '../dist/engine.mjs';
import {demoScene} from './fixtures.mjs';
const correct={ram:{x:100,y:300,w:100,h:40},target:{x:100,y:300,w:100,h:40},others:[],reversed:false};
test('three scenarios at different observation rates',()=>{
  for(const fps of [15,30,60])for(const scenario of ['normal','reversed','wrong']){
    const engine=new AssemblyEngine(),warnings=new Set();
    for(let t=0;t<15000;t+=1000/fps){const s=engine.update(demoScene(scenario,t),t);if(s.warning)warnings.add(s.warning);}
    assert.equal(engine.state==='COMPLETE',scenario==='normal');
    assert.equal(engine.errors,scenario==='normal'?0:3);
    assert.deepEqual([...warnings],scenario==='normal'?[]:[scenario==='wrong'?'WRONG_SLOT':'REVERSED_RAM']);
  }
});
test('occlusion, misalignment and reversal restart completion duration',()=>{
  for(const interruption of [{...correct,ram:null},{...correct,reversed:true},{...correct,ram:{...correct.ram,y:230}}]){
    const e=new AssemblyEngine();
    for(let t=0;t<=600;t+=50)e.update(correct,t);
    assert.notEqual(e.state,'COMPLETE');e.update(interruption,650);
    for(let t=700;t<1100;t+=50){e.update(correct,t);assert.notEqual(e.state,'COMPLETE');}
    for(let t=1100;t<=1600;t+=50)e.update(correct,t);
    assert.equal(e.state,'COMPLETE');assert.equal(e.warning,'');
  }
});
test('missing observations break scan and completion',()=>{
  const e=new AssemblyEngine();e.update(correct,0);e.update(correct,100);e.update({...correct,ram:null},130);
  e.update(correct,150);e.update(correct,250);assert.equal(e.state,'SCAN');
  e.update(correct,350);e.update(correct,400);e.update(correct,800);assert.equal(e.state,'SCAN');
});
test('warnings count episodes, recover, and reset',()=>{
  const e=new AssemblyEngine();
  for(let t=0;t<=1000;t+=50)e.update({...correct,reversed:true},t);
  assert.equal(e.errors,1);
  e.update({...correct,ram:{...correct.ram,y:100}},1050);
  e.update({...correct,reversed:true},1100);assert.equal(e.errors,2);
  for(let t=1150;t<=1800;t+=50)e.update(correct,t);
  assert.equal(e.state,'COMPLETE');assert.equal(e.warning,'');
  e.reset();assert.equal(e.errors,0);assert.equal(e.state,'SCAN');
});
