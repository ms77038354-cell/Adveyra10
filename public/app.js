const $ = id => document.getElementById(id);
const agentBusyLabel = 'Thinking · inspecting · building…';
let chat = [], activeFile = null, currentFiles = [], selectedFiles = new Set(), previewVersion = Date.now();
let attachedImages = [], deviceMode = 'desktop', previewZoom = 1, recognition = null;

async function api(url, options = {}) {
  const headers = { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) };
  const response = await fetch(url, { ...options, headers });
  const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : {};
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function addBubble(role, content) {
  const wrap = document.createElement('div'); wrap.className = `bubble-wrap ${role}`;
  const div = document.createElement('div'); div.className = `bubble ${role}`; div.textContent = content; wrap.appendChild(div);
  if (role === 'assistant') {
    const actions = document.createElement('div'); actions.className = 'message-actions';
    const copy = document.createElement('button'); copy.type='button'; copy.textContent='Copy'; copy.onclick=()=>navigator.clipboard?.writeText(content).then(()=>copy.textContent='Copied').catch(()=>{});
    const speak = document.createElement('button'); speak.type='button'; speak.textContent='🔊 Listen'; speak.onclick=()=>{if(!('speechSynthesis' in window))return alert('Speech output is not supported in this browser.');speechSynthesis.cancel();speechSynthesis.speak(new SpeechSynthesisUtterance(content));};
    actions.append(copy,speak); wrap.appendChild(actions);
  }
  $('chatMessages').appendChild(wrap); $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
}
function updateSelectionUI() {
  $('selectedCount').textContent = `${selectedFiles.size} selected`;
  $('downloadSelectedBtn').disabled = selectedFiles.size === 0;
  $('deleteSelectedBtn').disabled = selectedFiles.size === 0;
  const files = currentFiles.filter(x => x.type === 'file');
  $('selectAllFiles').checked = files.length > 0 && files.every(x => selectedFiles.has(x.path));
  $('selectAllFiles').indeterminate = selectedFiles.size > 0 && !$('selectAllFiles').checked;
}
async function refreshFiles(reloadActive = true) {
  const data = await api('/api/files'); currentFiles = data.files || [];
  const valid = new Set(currentFiles.filter(x => x.type === 'file').map(x => x.path));
  selectedFiles = new Set([...selectedFiles].filter(x => valid.has(x)));
  const list = $('fileList'); list.innerHTML = '';
  const files = currentFiles.filter(x => x.type === 'file');
  if (!files.length) list.innerHTML = '<p class="muted tiny">No project files yet. Ask the agent to create a website or app.</p>';
  files.forEach(file => {
    const row = document.createElement('div'); row.className = 'file-row';
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selectedFiles.has(file.path); check.setAttribute('aria-label', `Select ${file.path}`);
    check.onchange = () => { check.checked ? selectedFiles.add(file.path) : selectedFiles.delete(file.path); updateSelectionUI(); };
    const btn = document.createElement('button'); btn.className = 'file-item' + (activeFile === file.path ? ' active' : ''); btn.textContent = '▤  ' + file.path; btn.onclick = () => openFile(file.path);
    row.append(check, btn); list.appendChild(row);
  });
  updateSelectionUI();
  if (reloadActive && activeFile && valid.has(activeFile)) {
    try { const latest = await api(`/api/file?path=${encodeURIComponent(activeFile)}`); $('editor').value = latest.content; }
    catch (e) { $('status').textContent = `Refresh warning: ${e.message}`; }
  }
}
async function openFile(filePath) {
  const data = await api(`/api/file?path=${encodeURIComponent(filePath)}`); activeFile = data.path;
  $('currentFile').textContent = data.path; $('editor').value = data.content;
  ['saveFile','renameFile','deleteFile'].forEach(id => $(id).disabled = false);
  await refreshFiles(false);
  if (data.path.toLowerCase().endsWith('.html')) loadPreview(data.path);
}
async function checkSession() {
  const data = await api('/api/session'); $('login').classList.toggle('hidden', data.authenticated); $('app').classList.toggle('hidden', !data.authenticated);
  if (data.authenticated) { $('status').textContent = 'Signed in · AI provider settings available'; await refreshFiles(); await loadProviderSettings(); }
}
$('loginForm').addEventListener('submit', async e => { e.preventDefault(); $('loginError').textContent=''; try { await api('/api/login',{method:'POST',body:JSON.stringify({username:$('username').value,password:$('password').value})}); await checkSession(); } catch(err){$('loginError').textContent=err.message;} });
$('logoutBtn').onclick = async()=>{await api('/api/logout',{method:'POST'});location.reload();};
$('refreshFiles').onclick=()=>refreshFiles(true).then(()=>$('status').textContent='Files refreshed').catch(e=>alert(e.message));
$('saveFile').onclick=async()=>{try{await api('/api/file',{method:'POST',body:JSON.stringify({path:activeFile,content:$('editor').value})});$('status').textContent=`Saved ${activeFile}`;await refreshFiles(false);if(activeFile?.toLowerCase().endsWith('.html'))loadPreview(activeFile);}catch(e){alert(e.message);}};
$('newFileBtn').onclick=async()=>{const p=prompt('New file path (example: index.html):');if(!p)return;try{await api('/api/file',{method:'POST',body:JSON.stringify({path:p,content:''})});await refreshFiles();await openFile(p);}catch(e){alert(e.message);}};
$('newFolderBtn').onclick=async()=>{const p=prompt('New folder path (example: src/components):');if(!p)return;try{await api('/api/folder',{method:'POST',body:JSON.stringify({path:p})});await refreshFiles();}catch(e){alert(e.message);}};
$('renameFile').onclick=async()=>{if(!activeFile)return;const next=prompt('Rename file to (relative path):',activeFile);if(!next||next===activeFile)return;try{await api('/api/rename',{method:'POST',body:JSON.stringify({from:activeFile,to:next})});activeFile=next;await refreshFiles();await openFile(next);}catch(e){alert(e.message);}};
$('deleteFile').onclick=async()=>{if(!activeFile||!confirm(`Delete ${activeFile}? A backup copy will be kept.`))return;try{await api('/api/file',{method:'DELETE',body:JSON.stringify({path:activeFile})});activeFile=null;$('currentFile').textContent='Select a file';$('editor').value='';['saveFile','renameFile','deleteFile'].forEach(id=>$(id).disabled=true);await refreshFiles();}catch(e){alert(e.message);}};
$('selectAllFiles').onchange=()=>{selectedFiles=$('selectAllFiles').checked?new Set(currentFiles.filter(x=>x.type==='file').map(x=>x.path)):new Set();refreshFiles(false);};
$('deleteSelectedBtn').onclick=async()=>{const paths=[...selectedFiles];if(!paths.length)return;if(!confirm(`Permanently delete ${paths.length} selected file(s)? Backup copies will be kept.`))return;try{const d=await api('/api/files/bulk-delete',{method:'POST',body:JSON.stringify({paths})});if(paths.includes(activeFile)){activeFile=null;$('currentFile').textContent='Select a file';$('editor').value='';['saveFile','renameFile','deleteFile'].forEach(id=>$(id).disabled=true);}selectedFiles.clear();await refreshFiles(false);$('status').textContent=`Deleted ${d.deleted} files; backups created.`;}catch(e){alert(e.message);}};
$('downloadSelectedBtn').onclick=async()=>{const paths=[...selectedFiles];if(!paths.length)return;try{const r=await fetch('/api/files/download-selected',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({paths})});if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.error||'Download failed');}const blob=await r.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='adveyra-selected-files.zip';a.click();URL.revokeObjectURL(url);}catch(e){alert(e.message);}};
async function uploadSingleFile(file){const target=prompt('Save uploaded file as (relative path):',file.name);if(!target)return;const form=new FormData();form.append('file',file);form.append('path',target);const data=await api('/api/upload-file',{method:'POST',body:form});await refreshFiles();await openFile(data.path);$('status').textContent=`Uploaded ${data.path}`;}
$('uploadFileBtn').onclick=()=>$('uploadFileInput').click();$('uploadFileInput').onchange=async e=>{const f=e.target.files?.[0];if(f)try{await uploadSingleFile(f);}catch(err){alert(err.message);}e.target.value='';};
$('importZipBtn').onclick=()=>$('importZipInput').click();$('importZipInput').onchange=async e=>{const f=e.target.files?.[0];if(!f)return;if(!confirm(`Extract ${f.name}? Matching existing files will be backed up.`)){e.target.value='';return;}try{const form=new FormData();form.append('archive',f);const d=await api('/api/import-zip',{method:'POST',body:form});await refreshFiles();$('status').textContent=`Imported ${d.imported} files`;const html=(d.files||[]).find(x=>x.toLowerCase().endsWith('.html'));if(html)await openFile(html);alert(`Imported ${d.imported} files. Existing matches were backed up.`);}catch(err){alert(err.message);}e.target.value='';};
$('diagnosticsBtn').onclick=async()=>{try{const d=await api('/api/diagnostics');alert(`ADVEYRA diagnostics\nModel: ${d.model}\n\n${d.checks.map(c=>`${c.ok?'✓':'✕'} ${c.name}: ${c.detail}`).join('\n')}`);}catch(e){alert(e.message);}};
$('exportBtn').onclick=()=>location.href='/api/export';

// Multimodal image attachments: image data is sent to Gemini through the authenticated backend.
function renderAttachments(){const wrap=$('attachmentPreview');wrap.innerHTML='';attachedImages.forEach((item,i)=>{const chip=document.createElement('div');chip.className='attachment-chip';const img=document.createElement('img');img.src=item.data;img.alt=item.name;const label=document.createElement('span');label.textContent=item.name;const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.onclick=()=>{attachedImages.splice(i,1);renderAttachments();};chip.append(img,label,remove);wrap.append(chip);});}
$('attachImageBtn').onclick=()=>$('imageInput').click();
$('imageInput').onchange=async e=>{for(const file of [...(e.target.files||[])]){if(!file.type.startsWith('image/'))continue;if(file.size>3_500_000){alert(`${file.name} is too large. Please use an image under 3.5 MB.`);continue;}if(attachedImages.length>=4){alert('You can attach up to 4 images per message.');break;}const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);});attachedImages.push({name:file.name,mimeType:file.type,data});}renderAttachments();e.target.value='';};
// Browser speech recognition is used as a safe transcription layer; recognized text remains editable.
const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;
if(SpeechRecognition){recognition=new SpeechRecognition();recognition.lang='hi-IN';recognition.interimResults=true;recognition.continuous=false;recognition.onresult=e=>{$('prompt').value=[...e.results].map(x=>x[0].transcript).join(' ');};recognition.onerror=e=>$('voiceStatus').textContent=`Voice error: ${e.error}`;recognition.onend=()=>$('voiceStatus').textContent='Voice capture finished · review text before sending';}
$('voiceBtn').onclick=()=>{if(!recognition){$('voiceStatus').textContent='Speech recognition is not supported in this browser. Try Chrome.';return;}try{recognition.lang=$('voiceLanguage').value;$('voiceStatus').textContent='Listening…';recognition.start();}catch(e){$('voiceStatus').textContent='Microphone may already be active.';}};

$('chatForm').addEventListener('submit',async e=>{e.preventDefault();const text=$('prompt').value.trim();if(!text&&!attachedImages.length)return;const images=attachedImages.map(({name,mimeType,data})=>({name,mimeType,data}));const visible=text||'Please inspect the attached image(s) and help me with them.';$('prompt').value='';attachedImages=[];renderAttachments();chat.push({role:'user',content:visible});addBubble('user',visible+(images.length?`\n📎 ${images.length} image(s) attached`:''));$('sendBtn').disabled=true;$('sendBtn').textContent='Working…';$('status').textContent=agentBusyLabel;try{const data=await api('/api/chat',{method:'POST',body:JSON.stringify({messages:chat,images,provider:$('chatProvider').value})});chat.push({role:'assistant',content:data.reply});addBubble('assistant',data.reply);await refreshFiles(true);}catch(err){addBubble('assistant','Error: '+err.message);}finally{$('sendBtn').disabled=false;$('sendBtn').textContent='Send ↗';$('status').textContent='Ready';}});


async function loadProviderSettings(){
  try{
    const d=await api('/api/settings/providers');
    $('defaultProvider').value=d.provider||'gemini'; $('chatProvider').value=d.provider||'gemini';
    $('geminiModelInput').value=d.geminiModel||'gemini-3.1-flash-lite'; $('openaiModelInput').value=d.openaiModel||'gpt-5.3-codex';
    $('geminiKeyStatus').textContent=d.geminiKeySet?'✓ Key configured (hidden)':'No key configured';
    $('openaiKeyStatus').textContent=d.openaiKeySet?'✓ Key configured (hidden)':'No key configured';
    if(d.variableNames?.length) $('projectVariablesInput').placeholder='Saved variables: '+d.variableNames.join(', ')+' (values hidden; enter JSON to replace)';
    updateModelLabel();
  }catch(e){$('settingsSaveStatus').textContent=e.message;}
}
function updateModelLabel(){const p=$('chatProvider').value;$('activeModelLabel').textContent=p==='openai'?`OpenAI · ${$('openaiModelInput').value}`:`Gemini · ${$('geminiModelInput').value}`;}
$('aiSettingsBtn').onclick=()=>{$('aiSettingsModal').classList.remove('hidden');loadProviderSettings();};
$('closeAiSettings').onclick=()=>$('aiSettingsModal').classList.add('hidden');
$('chatProvider').onchange=updateModelLabel;
$('defaultProvider').onchange=()=>$('chatProvider').value=$('defaultProvider').value;
$('geminiModelInput').onchange=updateModelLabel;$('openaiModelInput').onchange=updateModelLabel;
$('saveAiSettings').onclick=async()=>{
  $('settingsSaveStatus').textContent='Saving securely…';
  try{
    const d=await api('/api/settings/providers',{method:'POST',body:JSON.stringify({
      provider:$('defaultProvider').value,geminiModel:$('geminiModelInput').value,openaiModel:$('openaiModelInput').value,
      geminiKey:$('geminiKeyInput').value,openaiKey:$('openaiKeyInput').value,
      variables:$('projectVariablesInput').value.trim()?JSON.parse($('projectVariablesInput').value):undefined
    })});
    $('geminiKeyInput').value='';$('openaiKeyInput').value='';$('settingsSaveStatus').textContent=d.note||'Saved.';
    await loadProviderSettings();$('chatProvider').value=$('defaultProvider').value;if(d.variableNames?.length) $('projectVariablesInput').placeholder='Saved variables: '+d.variableNames.join(', ')+' (values hidden; enter JSON to replace)';
    updateModelLabel();
  }catch(e){$('settingsSaveStatus').textContent=e.message;}
};
async function testProvider(provider){
  const status=$(provider==='openai'?'openaiKeyStatus':'geminiKeyStatus');status.textContent='Testing…';
  try{const d=await api('/api/settings/test',{method:'POST',body:JSON.stringify({provider})});status.textContent='✓ '+d.message;}
  catch(e){status.textContent='✕ '+e.message;}
}
$('testGeminiBtn').onclick=()=>testProvider('gemini');$('testOpenAIBtn').onclick=()=>testProvider('openai');
function previewDimensions(){return deviceMode==='mobile'?{w:390,h:844,label:'Mobile · 390 px'}:deviceMode==='tablet'?{w:768,h:1024,label:'Tablet · 768 px'}:{w:null,h:null,label:'Desktop · responsive width'};}
function applyPreviewFrame(){const frame=$('preview'),stage=$('previewStage'),d=previewDimensions();$('deviceLabel').textContent=d.label;frame.style.width=d.w?`${d.w}px`:'100%';frame.style.height=d.h?`${d.h}px`:'100%';frame.style.maxWidth='none';frame.style.transform='none';frame.style.transformOrigin='top center';const available=stage.clientWidth-24;const scale=d.w?Math.min(1,available/d.w)*previewZoom:previewZoom;frame.style.transform=`scale(${scale})`;stage.style.height=d.h?`${Math.max(380,d.h*scale+24)}px`:'';stage.style.overflow='auto';frame.style.marginLeft=d.w&&scale<1?'0':'auto';frame.style.marginRight='auto';}
function loadPreview(filePath){if(!filePath||!filePath.toLowerCase().endsWith('.html'))throw new Error('Select an .html file first.');previewVersion=Date.now();const encoded=filePath.split('/').map(encodeURIComponent).join('/');$('preview').src=`/preview/${encoded}?v=${previewVersion}`;$('preview').onload=()=>{$('status').textContent=`Preview loaded: ${filePath}`;applyPreviewFrame();};$('status').textContent=`Loading preview: ${filePath}`;}
$('previewBtn').onclick=async()=>{if(!activeFile||!activeFile.toLowerCase().endsWith('.html')){alert('Select an .html file first.');return;}try{await api('/api/file',{method:'POST',body:JSON.stringify({path:activeFile,content:$('editor').value})});loadPreview(activeFile);}catch(e){alert(`Preview could not be loaded: ${e.message}`);}};
document.querySelectorAll('.device-btn').forEach(btn=>btn.onclick=()=>{deviceMode=btn.dataset.device;document.querySelectorAll('.device-btn').forEach(x=>x.classList.toggle('active',x===btn));previewZoom=1;applyPreviewFrame();});
$('zoomInBtn').onclick=()=>{previewZoom=Math.min(1.5,previewZoom+.1);applyPreviewFrame();};$('zoomOutBtn').onclick=()=>{previewZoom=Math.max(.4,previewZoom-.1);applyPreviewFrame();};$('fitPreviewBtn').onclick=()=>{previewZoom=1;applyPreviewFrame();};$('reloadPreviewBtn').onclick=()=>{if(activeFile?.toLowerCase().endsWith('.html'))loadPreview(activeFile);else if($('preview').src)$('preview').contentWindow.location.reload();};async function exitPreviewFullscreen(){if(document.fullscreenElement){try{await document.exitFullscreen();}catch(e){console.warn('Could not exit fullscreen',e);}}}
$('fullscreenBtn').onclick=async()=>{try{if(!$('previewStage').requestFullscreen)throw new Error('Fullscreen is not supported in this browser.');await $('previewStage').requestFullscreen();}catch(e){alert(e.message);}};
$('exitFullscreenBtn').onclick=exitPreviewFullscreen;
document.addEventListener('fullscreenchange',()=>{const active=document.fullscreenElement===$('previewStage');$('exitFullscreenBtn').classList.toggle('visible',active);$('fullscreenBtn').textContent=active?'Exit Fullscreen':'Fullscreen';setTimeout(applyPreviewFrame,80);});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.fullscreenElement===$('previewStage'))exitPreviewFullscreen();});
document.querySelectorAll('[data-prompt]').forEach(btn=>btn.addEventListener('click',()=>{$('prompt').value=btn.dataset.prompt;$('prompt').focus();$('prompt').dispatchEvent(new Event('input',{bubbles:true}));}));
window.addEventListener('resize',applyPreviewFrame);
$('apiSendBtn').onclick=async()=>{const url=$('apiUrl').value.trim();if(!url){$('apiResult').textContent='Enter your backend API URL first.';return;}let headers,body;try{headers=JSON.parse($('apiHeaders').value||'{}');if(!headers||Array.isArray(headers)||typeof headers!=='object')throw new Error('Headers must be a JSON object.');}catch(e){$('apiResult').textContent=`Headers error: ${e.message}`;return;}const method=$('apiMethod').value;try{body=method==='GET'||method==='DELETE'?undefined:$('apiBody').value.trim();if(body)JSON.parse(body);}catch(e){$('apiResult').textContent=`Request body must be valid JSON: ${e.message}`;return;}const started=performance.now();$('apiSendBtn').disabled=true;$('apiResult').textContent='Sending request…';try{const response=await fetch(url,{method,headers,body});const raw=await response.text();let formatted=raw;try{formatted=JSON.stringify(JSON.parse(raw),null,2);}catch{}$('apiResult').textContent=`${response.status} ${response.statusText} · ${Math.round(performance.now()-started)} ms\n\n${formatted.slice(0,20000)}`;}catch(e){$('apiResult').textContent=`Request failed: ${e.message}\nCheck the URL, network access and CORS settings on your backend.`;}finally{$('apiSendBtn').disabled=false;}};
$('pushBtn').onclick=async()=>{if(!confirm('Push the current workspace files to the configured GitHub repository?'))return;$('pushBtn').disabled=true;try{const d=await api('/api/github/push',{method:'POST',body:JSON.stringify({message:'Update from ADVEYRA AI Studio'})});alert('GitHub push successful: '+d.url);}catch(e){alert(e.message);}finally{$('pushBtn').disabled=false;}};
checkSession().catch(()=>{});

// Welcome dashboard shortcuts
const startBuildingBtn = document.getElementById('startBuildingBtn');
if (startBuildingBtn) startBuildingBtn.addEventListener('click', () => {
  document.getElementById('prompt')?.focus();
  document.querySelector('.chat-panel')?.scrollIntoView({behavior:'smooth', block:'center'});
});
const dashboardGuideBtn = document.getElementById('dashboardGuideBtn');
if (dashboardGuideBtn) dashboardGuideBtn.addEventListener('click', () => {
  const guide = document.getElementById('dashboardGuide');
  if (guide) {
    guide.classList.toggle('hidden');
    dashboardGuideBtn.textContent = guide.classList.contains('hidden') ? 'How it works' : 'Hide guide';
  }
});
