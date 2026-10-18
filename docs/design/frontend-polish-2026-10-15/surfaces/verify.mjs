import { chromium } from '/Users/wytze/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
const browser=await chromium.launch({headless:true,executablePath:'/Users/wytze/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
const page=await browser.newPage({viewport:{width:860,height:620},deviceScaleFactor:1,reducedMotion:'reduce'});
const errors=[],checks=[];page.on('pageerror',e=>errors.push(e.message));
const assert=(value,message)=>{if(!value)throw Error(message);checks.push(message);};
async function screenshot(name){await page.screenshot({path:`/tmp/gyro-surface-polish/${name}.png`});}
async function noOverflow(selector){return await page.locator(selector).evaluateAll(es=>es.filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>({cls:e.className,client:e.clientWidth,scroll:e.scrollWidth})));}
for(const theme of ['dark','light']){
  await page.goto(`http://127.0.0.1:1420/settings-preview.html?theme=${theme}`);await page.locator('.gyro-settings-row').first().waitFor();await page.waitForTimeout(150);
  for(const size of ['small','default','large'])for(const density of ['compact','comfortable']){
    await page.evaluate(({size,density})=>{document.documentElement.dataset.interfaceSize=size;document.documentElement.dataset.density=density;},{size,density});
    assert((await noOverflow('.gyro-settings-row,.gyro-settings-control-column')).length===0,`Settings fits 860px ${theme} ${size} ${density}`);
  }
  await page.evaluate(()=>document.querySelector('.gyro-settings-content').style.maxWidth='460px');
  const colors=await page.locator('.gyro-settings-row:has(.gyro-color-control)').first().evaluate(e=>({row:e.getBoundingClientRect().toJSON(),label:e.firstElementChild.getBoundingClientRect().toJSON(),control:e.lastElementChild.getBoundingClientRect().toJSON()}));
  assert(colors.control.top>=colors.label.bottom,'Narrow accent controls stack below labels');
  await screenshot(`settings-after-${theme}-narrow-large`);
  await page.getByRole('button',{name:'Keyboard Shortcuts',exact:true}).click();
  await page.locator('.gyro-workspace-keybindings input').first().waitFor();
  assert((await noOverflow('.gyro-workspace-keybindings label')).length===0,`Keybindings fit narrow ${theme} large`);
  await screenshot(`keybindings-after-${theme}-narrow-large`);
  await page.goto(`http://127.0.0.1:1420/review-fixture.html?theme=${theme}&width=360&many-edits&size=large`);await page.locator('.gyro-diff-review-toolbar').first().waitFor();
  assert((await noOverflow('.gyro-diff-review-toolbar,.gyro-recorded-diff-controls')).length===0,`Review controls fit 360px ${theme} large`);
  await page.getByRole('combobox',{name:'Recorded edit'}).selectOption('0');assert(await page.getByText('Recorded edit 1 of 8',{exact:true}).isVisible(),'Recorded edit selector updates diff');
  await page.getByRole('button',{name:'Compare current file',exact:true}).click();assert(await page.getByText('Current working tree comparison',{exact:true}).isVisible(),'Current comparison opens');
  await page.getByRole('button',{name:'Back to recorded turn',exact:true}).click();await page.getByRole('combobox',{name:'Recorded edit'}).focus();
  assert(await page.getByRole('combobox',{name:'Recorded edit'}).evaluate(e=>getComputedStyle(e).outlineStyle)==='solid','Review select has visible focus');
  await screenshot(`review-after-${theme}-narrow-large`);
  await page.goto(`http://127.0.0.1:1420/automations-preview.html?theme=${theme}&size=large&state=long`);await page.locator('.gyro-scheduled-item').click();await page.locator('.gyro-automation-detail').waitFor();
  assert((await noOverflow('.gyro-automation-detail,.gyro-automation-run-entry')).length===0,`Automation long state fits 860px ${theme} large`);
  await page.getByText('Advanced settings',{exact:true}).click();assert(await page.locator('.gyro-automation-advanced').getAttribute('open')!==null,'Automation advanced details open');
  await screenshot(`automation-after-${theme}-large`);
}
async function mountDialog(theme,width,height){
  await page.setViewportSize({width,height});await page.goto(`http://127.0.0.1:1420/settings-preview.html?theme=${theme}`);await page.locator('.gyro-settings-row').first().waitFor();await page.waitForTimeout(150);
  await page.evaluate(async()=>{const {PullRequestForm}=await import('/@fs/Users/wytze/Gyro/packages/ui/src/pull-request-form.tsx');const {default:React}=await import('/node_modules/.vite/deps/react.js');const {default:ReactDOM}=await import('/node_modules/.vite/deps/react-dom_client.js');const root=document.createElement('div');document.body.append(root);window.__dialogResult='pending';ReactDOM.createRoot(root).render(React.createElement(PullRequestForm,{initial:{title:'  Refine the workspace experience  ',body:'Make the next step clear and keep controls aligned.',base:'main',head:'polish-workspace',draft:true},onClose:value=>window.__dialogResult=value??'cancelled'}));});
  await page.locator('.gyro-workflow-form').waitFor();
}
for(const theme of ['dark','light']){
 await mountDialog(theme,860,620);
 const visual=await page.locator('.gyro-workflow-form').evaluate(e=>({shadow:getComputedStyle(e).boxShadow,checkDisplay:getComputedStyle(e.querySelector('input[type=checkbox]').parentElement).display,buttons:[...e.querySelectorAll('button')].map(b=>getComputedStyle(b).backgroundColor)}));
 assert(visual.shadow!=='none',`Dialog shadow resolves ${theme}`);assert(visual.buttons[0]!==visual.buttons[1],`Dialog primary differs from Cancel ${theme}`);assert(visual.checkDisplay==='flex','Draft checkbox uses inline row');
 await screenshot(`workflow-after-${theme}`);
 await page.getByRole('button',{name:'Create pull request',exact:true}).focus();await page.keyboard.press('Tab');assert(await page.getByLabel('Title',{exact:true}).evaluate(e=>e===document.activeElement),'Dialog Tab loops to first input');
 await page.keyboard.press('Shift+Tab');assert(await page.getByRole('button',{name:'Create pull request',exact:true}).evaluate(e=>e===document.activeElement),'Dialog Shift Tab loops to last action');
 await page.getByRole('button',{name:'Create pull request',exact:true}).click();assert(await page.evaluate(()=>window.__dialogResult.title)==='Refine the workspace experience','Dialog submit trims title and delivers draft');
 await mountDialog(theme,500,400);
 const bounds=await page.locator('.gyro-workflow-form').evaluate(e=>({r:e.getBoundingClientRect().toJSON(),scroll:e.scrollHeight,client:e.clientHeight}));
 assert(bounds.r.top>=0&&bounds.r.bottom<=400&&bounds.r.left>=0&&bounds.r.right<=500,`Dialog remains inside 500x400 ${theme}`);assert(bounds.scroll>bounds.client,'Short dialog scrolls');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();assert(await page.evaluate(()=>window.__dialogResult)==='cancelled','Dialog Cancel remains reachable in short window');
 await screenshot(`workflow-after-${theme}-short`);
}
assert(errors.length===0,'No page runtime errors');
await fs.writeFile('/tmp/gyro-surface-polish/verification.json',JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({passed:checks.length,errors}));await browser.close();
