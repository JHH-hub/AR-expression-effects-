// Run against a local server using Playwright. Fake camera is explicitly used;
// these checks cannot establish human expression accuracy.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs=require('node:fs');
const base=process.env.TEST_BASE || 'http://127.0.0.1:8089';
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 const context=await browser.newContext({viewport:{width:1280,height:900},permissions:['camera']});
 const page=await context.newPage(), errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 const results={date:new Date().toISOString(),base,browser:await browser.version(),camera:'synthetic device, no human',checks:[]};
 await page.goto(base+'/tests/render-smoke.html');
 for(const selector of ['#gpu','#fallback']){
  await page.click(selector);await page.waitForFunction(()=>document.querySelector('#result').textContent.startsWith('PASS'),{},{timeout:30000});
  results.checks.push(await page.locator('#result').innerText());
  if(selector==='#fallback' && !results.checks.at(-1).includes('Canvas2D'))throw Error('Fallback backend not confirmed');
 }
 results.gpuCollision=await page.evaluate(async()=>{
  const {GLRenderer}=await import('/src/glRenderer.js?v=20261008a');
  const c=document.createElement('canvas'),r=new GLRenderer(c);r.setQuality(0);r.resize(390,540);
  const gl=r.gl, tests=[];
  for(const moving of [false,true]){
   const h={x:moving?240:195,y:290,rx:40,ry:40,valid:true,prevValid:true,prevX:moving?150:195,prevY:290,prevRx:40,prevRy:40};
   r.setHead(h);r.setRain(0);
   const id=r.rainSlots, x=id%r.texSize,y=Math.floor(id/r.texSize),s=r.states[r.src];
   const upload=(tex,data)=>{gl.bindTexture(gl.TEXTURE_2D,tex);gl.texSubImage2D(gl.TEXTURE_2D,0,x,y,1,1,gl.RGBA,gl.FLOAT,new Float32Array(data));};
   upload(s.t0,[moving?205:100,290,moving?0:3800,0]);upload(s.t1,[1,1,.2,.4]);
   r._simulate(.05);gl.bindFramebuffer(gl.FRAMEBUFFER,r.states[r.src].fbo);gl.readBuffer(gl.COLOR_ATTACHMENT0);
   const out=new Float32Array(4);gl.readPixels(x,y,1,1,gl.RGBA,gl.FLOAT,out);
   const err=gl.getError();if(err || (moving?out[2]<=0:out[2]>=0))throw Error('GPU collision failure '+JSON.stringify({moving,out:[...out],err}));
   tests.push({movingHead:moving,state:[...out],glError:err});
  }
  r.dispose();return tests;
 });
 await page.goto(base+'/');
 const button=page.locator('button').filter({hasText:/开启|开始/}).first();
 const start=Date.now();await button.click();
 try {
  await page.waitForFunction(()=>window.__ar?.renderer && window.__ar?.tracker?.landmarker,{},{timeout:90000});
  results.startupMs=Date.now()-start;
  results.cameraModel=await page.evaluate(()=>({backend:__ar.backend,delegate:__ar.tracker.delegate,tracks:__ar.tracker.stream.getVideoTracks().map(t=>({state:t.readyState,settings:t.getSettings()})),calibrating:__ar.fsm.calibrating}));
 }catch(e){results.cameraModel={error:String(e),visibleText:await page.locator('body').innerText()};}
 results.errors=errors;
 fs.mkdirSync('tmp/acceptance',{recursive:true});
 await page.screenshot({path:'tmp/acceptance/startup.png'});
 fs.writeFileSync('tmp/acceptance/browser.json',JSON.stringify(results,null,2));
 console.log(JSON.stringify(results,null,2));await browser.close();
 if(errors.length || results.cameraModel.error)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
