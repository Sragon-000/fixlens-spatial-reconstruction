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
