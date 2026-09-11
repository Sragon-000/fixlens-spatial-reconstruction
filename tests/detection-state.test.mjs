import test from 'node:test';
import assert from 'node:assert/strict';
import {DetectionState} from '../dist/detection-state.mjs';
const box={bbox:[64,48,128,96],class:'cup',score:.9};
test('one inference at a time and normalized portrait/landscape coordinates',()=>{
  const d=new DetectionState(),job=d.begin(0,640,480);assert.equal(d.begin(10,640,480),null);
  assert.ok(d.accept({id:job.id,results:[box]},100));
  assert.equal(d.visible(100)[0].name,'cup');
  for(const [key,value] of Object.entries({x:.1,y:.1,w:.2,h:.2}))assert.ok(Math.abs(d.visible(100)[0][key]-value)<1e-9);
  assert.equal(d.visible(800).length,0);
});
test('camera restart invalidates old results without starting overlapping inference',()=>{
  const d=new DetectionState(),job=d.begin(0,640,480);d.clear();assert.equal(d.begin(10,640,480),null);
  assert.equal(d.accept({id:job.id,results:[box]},100),false);assert.equal(d.visible(100).length,0);
  assert.ok(d.begin(110,480,640));
});
test('stale results, empty results and malformed boxes never linger',()=>{
  const d=new DetectionState();let job=d.begin(0,640,480);
  assert.equal(d.accept({id:job.id,results:[box]},2100),false);
  job=d.begin(2200,640,480);d.accept({id:job.id,results:[box,{...box,bbox:[NaN,0,1,1]},{...box,score:.1}]},2300);
  assert.equal(d.visible(2300).length,1);
  job=d.begin(2400,640,480);d.accept({id:job.id,results:[]},2500);assert.equal(d.visible(2500).length,0);
});
test('brief partial misses are bounded and never held after an empty result',()=>{
  const d=new DetectionState(),other={...box,bbox:[400,48,100,96]};
  let job=d.begin(0,640,480);d.accept({id:job.id,results:[box,other]},100);
  job=d.begin(110,640,480);d.accept({id:job.id,results:[box]},150);
  assert.equal(d.visible(150).length,2);assert.equal(d.visible(150).filter(p=>p.held).length,1);
  assert.equal(d.visible(351).length,1);
  job=d.begin(360,640,480);d.accept({id:job.id,results:[]},400);assert.equal(d.visible(400).length,0);
});
test('same-class neighbors match one-to-one and gentle movement is smoothed',()=>{
  const d=new DetectionState(),other={...box,bbox:[400,48,100,96]};
  let job=d.begin(0,640,480);d.accept({id:job.id,results:[box,other]},100);
  job=d.begin(110,640,480);d.accept({id:job.id,results:[{...other,bbox:[410,48,100,96]},{...box,bbox:[74,48,128,96]}]},150);
  assert.equal(d.results.length,2);
  assert.ok(d.results[0].x>400/640&&d.results[0].x<410/640);
  assert.ok(d.results[1].x>64/640&&d.results[1].x<74/640);
});
