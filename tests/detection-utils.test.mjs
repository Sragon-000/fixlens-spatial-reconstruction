import test from 'node:test';
import assert from 'node:assert/strict';
import '../dist/detection-utils.js';
const {regions,merge}=globalThis.DetectionUtils;
test('overlapping detail regions cover portrait and landscape boundaries',()=>{
  for(const [w,h] of [[960,540],[405,720]]){
    const r=regions(w,h,true);assert.equal(r.length,5);assert.equal(regions(w,h,false).length,1);
    for(const p of r)assert.ok(p.x>=0&&p.y>=0&&p.x+p.w<=w&&p.y+p.h<=h);
    assert.equal(r.at(-1).x+r.at(-1).w,w);assert.equal(r.at(-1).y+r.at(-1).h,h);
  }
});
test('crop duplicates merge but neighboring and different-class objects survive',()=>{
  const box={bbox:[10,10,100,100],class:'cup',score:.9};
  assert.equal(merge([box,{...box,score:.8,bbox:[12,12,100,100]}]).length,1);
  assert.equal(merge([box,{...box,class:'person'},{...box,bbox:[300,10,100,100]}]).length,3);
  assert.equal(merge(Array.from({length:60},(_,i)=>({...box,bbox:[i*110,0,100,100]}))).length,50);
});
