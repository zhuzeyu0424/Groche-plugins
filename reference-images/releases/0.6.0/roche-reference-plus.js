/* Roche reference enhancement 0.6.0 */
(()=>{
// Shared by these two plugins. One entry point, removable handlers, no polling
// and no reassignment after asynchronous initialization.
function rocheFetchCoordinator(){
  const key=Symbol.for('roche.plugins.fetch-coordinator.v1');
  if(window[key])return window[key];
  const base=window.fetch,entries=new Map();let top=base;
  function dispatch(input,init){return top.call(this,input,init);}
  function rebuild(){let next=base;for(const e of entries.values()){e.next=next;next=e.handler;}top=next;}
  const hub={
    register(id,build){
      if(entries.has(id))throw Error('Duplicate request handler: '+id);
      const entry={next:base,handler:null};
      entry.handler=build(function(input,init){return entry.next.call(this,input,init);});
      if(typeof entry.handler!=='function')throw Error('Invalid request handler');
      entries.set(id,entry);rebuild();
      // Preserve wrappers installed by other applications. Never chase/re-wrap fetch.
      if(window.fetch===base)window.fetch=dispatch;
      return ()=>{if(entries.get(id)!==entry)return;entries.delete(id);rebuild();if(!entries.size&&window.fetch===dispatch)window.fetch=base;};
    },
    status(){return {handlers:[...entries.keys()],entryUnchanged:window.fetch===dispatch};}
  };
  Object.defineProperty(window,key,{value:hub,configurable:true});
  return hub;
}

/* Native Roche image references. No plugin registration, network interception or API key storage. */
function createRocheReferenceEngine(bridge) {
  const pending = new Map();
  const history = [...(bridge.initialHistory||[])].slice(0,12);
  const listeners = new Set();
  const profileKey = 'rocheImageReferencesV1';
  const clone = value => JSON.parse(JSON.stringify(value));
  const maxIdentityImages = 4;
  const blank = () => ({ enabled: false, identityMode: 'auto', identityImages: [], primaryIndices: [], styleImage: '', appearance: '', stylePrompt: '', pairedPersonaId:'', userSource:'auto', referenceMode:'natural', heightCm:0, subjectAliases:'', offlineUnnamedSolo:'auto' });
  const validImage = value => typeof value === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/.test(value) && value.length <= 8 * 1024 * 1024;
  function cleanProfile(value) {
    if (!value || typeof value !== 'object') throw new Error('参考设置格式不正确。');
    const result = blank();
    result.enabled = value.enabled === true;
    result.identityMode = value.identityMode === 'always' ? 'always' : 'auto';
    const identities = value.identityImages === undefined ? (value.identityImage ? [value.identityImage] : []) : value.identityImages;
    if (!Array.isArray(identities) || identities.length > maxIdentityImages) throw new Error('每个角色最多保存 4 张人物参考图。');
    if (identities.some(image => !validImage(image))) throw new Error('人物参考图片格式无效或过大，请重新选择 PNG、JPEG 或 WEBP 图片。');
    result.identityImages = [...identities];
    const selected = value.primaryIndices === undefined ? [0] : value.primaryIndices;
    if (!Array.isArray(selected) || selected.some(i => !Number.isInteger(i) || i < 0)) throw new Error('主参考选择格式不正确。');
    result.primaryIndices = [...new Set(selected.filter(i => i < identities.length))].sort((a,b)=>a-b);
    if (identities.length && !result.primaryIndices.length) result.primaryIndices = [0];
    for (const key of ['styleImage']) {
      if (value[key] && !validImage(value[key])) throw new Error('参考图片格式无效或过大，请重新选择 PNG、JPEG 或 WEBP 图片。');
      result[key] = value[key] || '';
    }
    for (const key of ['appearance', 'stylePrompt']) result[key] = String(value[key] || '').trim().slice(0, 4000);
    result.pairedPersonaId=String(value.pairedPersonaId||'').trim().slice(0,200);
    // Existing explicit pairs retain their meaning. New profiles follow the
    // persona selected by Roche for the actual generating conversation.
    result.userSource=['auto','fixed','off'].includes(value.userSource)?value.userSource:result.pairedPersonaId?'fixed':'auto';
    result.referenceMode=value.referenceMode==='faithful'?'faithful':'natural';
    const height=Number(value.heightCm);
    result.heightCm=Number.isFinite(height)&&height>=80&&height<=250?Math.round(height):0;
    result.subjectAliases=String(value.subjectAliases||'').trim().slice(0,500);
    result.offlineUnnamedSolo=['character','user'].includes(value.offlineUnnamedSolo)?value.offlineUnnamedSolo:'auto';
    return result;
  }
  const entities = () => bridge.entities();
  const find = id => entities().find(item => String(item.id) === String(id));
  function profile(id) { const entity = find(id); return entity?.[profileKey] ? cleanProfile(entity[profileKey]) : blank(); }
  async function save(id, value) {
    const entity = find(id);
    if (!entity) throw new Error('这个角色已不存在，请重新选择。');
    const checked = cleanProfile(value);
    await bridge.save(entity, checked);
    return checked;
  }
  function naturalRules(p) {
    return [
      'Reference photographs describe identity, not camera geometry. Reconstruct a coherent person in the new scene. Do not use the cropped head size, camera distance, lens distortion or outfit in a reference as the scale or clothing template. Keep realistic anatomical head-to-body proportions and continuous neck, shoulders and torso; no enlarged head or miniature body.',
      'Clothing, accessories, hairstyle arrangement, pose, expression, gaze, camera angle and lighting follow the CURRENT SCENE. If clothing is unspecified, choose a plausible outfit for the activity and weather rather than automatically repeating the reference outfit. Retain distinctive physical traits and any explicitly required mask design. Render the mask in the new angle and fabric folds, not as a flat pasted image.',
      p.referenceMode==='faithful'?'Stay close to the shared facial structure and distinguishing details across the references, while rendering a new expression and pose.':'Use shared identity cues across the references. Allow relaxed facial muscles, subtle asymmetry, natural blinking and scene-appropriate emotion; avoid a frozen reference expression or identical head angle in every image.',
      p.heightCm?'Subject height: '+p.heightCm+' cm. Use this as an approximate body-height cue, not a pixel measurement of the head.':''
    ].filter(Boolean).join(' ');
  }
  function options(id, prompt, legacy) {
    const entity = find(id);
    if (!entity || !Object.prototype.hasOwnProperty.call(entity, profileKey)) return legacy;
    return { ...legacy, rocheReferenceProfile: cleanProfile(entity[profileKey]), faceLockEntityId: entity.id,
      faceLockTargetName: entity.handle || entity.name || '该角色' };
  }
  function plan(prompt, config, artist, opts = {}) {
    let references = [], appearance = '', style = '', skipped = false;
    const p = opts.rocheReferenceProfile ? cleanProfile(opts.rocheReferenceProfile) : null;
    if (p) {
      if (p.enabled) {
        const useIdentity = p.identityMode === 'always' || bridge.identityAllowed(prompt, opts.faceLockEntityId);
        if (useIdentity) references.push(...p.identityImages.map((image, index) => ({ image, role: 'identity', primary: p.primaryIndices.includes(index) })));
        if (useIdentity) appearance = p.appearance || '';
        skipped = !useIdentity && Boolean(p.identityImages.length || p.appearance);
        if (p.styleImage) references.push({ image: p.styleImage, role: 'style' });
        style = p.stylePrompt || '';
      }
    } else {
      references = (opts.referenceImages || []).map(item => ({ image: typeof item === 'string' ? item : item.image, role: 'identity' }));
    }
    if (references.length > maxIdentityImages + 1) throw new Error('此版本最多提交 4 张人物图和 1 张画风图。');
    for (const ref of references) if (!validImage(ref.image)) throw new Error('参考图无法读取；已停止生成，请重新选择图片。');
    const instructions = references.map((ref, i) => ref.role === 'identity'
      ? `Reference image ${i + 1}: ${ref.primary !== false ? 'PRIMARY identity reference' : 'SUPPLEMENTARY detail reference'} for ${String(opts.faceLockTargetName || 'the intended main subject').slice(0, 160)}.`
      : `Reference image ${i + 1} is ONLY a visual style reference: use its rendering style, palette, lighting and texture. Do not copy its person's face, objects or composition unless requested.`);
    if (references.some(r => r.role === 'identity')) instructions.push('All identity references show the SAME person in different views or states, not separate characters. The PRIMARY references jointly define the identity: use their shared facial structure, age range, skin tone and distinctive marks. No single first image overrides the other PRIMARY images. Use SUPPLEMENTARY references for compatible details; do not blend incompatible faces or mask designs. Preserve the recognizable mask design when that mask is worn, but render it anew with perspective, fabric folds and lighting appropriate to the scene. Different hoods, head coverings and exposed-hair states are alternatives: follow the current scene, never combine them into one impossible outfit. Keep identity stable while allowing natural changes in expression, gaze, head angle, hair arrangement, body pose, framing and illumination. Do not paste or trace the reference head or repeat its fixed expression and composition. Follow explicit scene instructions for clothing and whether the face is covered. Do not copy this identity onto other people.');
    if (appearance) instructions.push('Stable appearance of the referenced subject: ' + appearance);
    if (references.some(r=>r.role==='identity')) instructions.push(naturalRules(p||blank()));
    if (style) instructions.push('Preferred visual style: ' + style);
    const text = [...instructions, config.oaiDefaultPositivePrompt || '', artist || '', prompt,
      config.oaiDefaultNegativePrompt ? 'Avoid: ' + config.oaiDefaultNegativePrompt : ''].filter(Boolean).join('\n\n');
    return { references, prompt: text, skipped };
  }
  function notify(record) {
    bridge.persistHistory?.(history);
    for (const listener of listeners) { try { listener(history); } catch (_) {} }
    if (record.state === 'failed') bridge.notify?.(record.message);
  }
  function planSubjects(scene, subjects) {
    if(!Array.isArray(subjects)||!subjects.length||subjects.length>2)throw Error('只能为已确认的一人或两人生成参考图。');
    if(subjects.length===1){
      const s=subjects[0],result=plan(scene,{},'',{rocheReferenceProfile:{...s.profile,identityMode:'always'},faceLockTargetName:(s.sceneRole==='char'?'main character / ':s.sceneRole==='user'?'user / ':'')+(s.person.name||s.person.handle)});
      result.references=result.references.map(r=>r.role==='identity'?{...r,subjectId:String(s.person.id),subjectName:s.person.name||s.person.handle}:r);return result;
    }
    const references=[],instructions=[];
    for(const [index,subject] of subjects.entries()){
      const p=cleanProfile(subject.profile),name=subject.person.name||subject.person.handle||subject.person.id;
      if(!p.enabled||!p.identityImages.length)throw Error('双人参考有一方尚未启用或没有人物图。');
      const indices=[...p.primaryIndices,...p.identityImages.map((_,i)=>i).filter(i=>!p.primaryIndices.includes(i))].slice(0,2);
      const imageNumbers=[];
      for(const i of indices){references.push({image:p.identityImages[i],role:'identity',primary:p.primaryIndices.includes(i),subjectId:String(subject.person.id),subjectName:name});imageNumbers.push(references.length);}
      instructions.push(`PERSON ${index+1}: ${name}.${subject.sceneRole?' Scene role: '+(subject.sceneRole==='char'?'main character':'user')+'.':''} Reference images ${imageNumbers.join(', ')} belong ONLY to this person. Preserve this person's facial proportions, eye shape, nose, skin tone, age and individual features. ${p.appearance?'Appearance for this person only: '+p.appearance:''}`);
      instructions.push('For PERSON '+(index+1)+' only: '+naturalRules(p));
    }
    const style=cleanProfile(subjects[0].profile);
    if(style.styleImage){references.push({image:style.styleImage,role:'style'});instructions.push(`Reference image ${references.length} is style only, not a third identity.`);}
    instructions.push('These are TWO DIFFERENT people. Never blend their faces, swap their identities, or apply one person\'s mask, hairstyle, facial structure or nationality-related appearance cues to the other. Within each person\'s reference group the images show the same identity. Other people described in the current scene must remain present and visually distinct, without copying either reference identity. Render new poses and expressions for the scene; do not paste reference heads. Keep the user\'s own facial features instead of making them resemble the other character.');
    instructions.push('Place both people in one consistent camera and perspective. Their relative apparent size must follow their body sizes, distance from the camera, posture and perspective in the CURRENT SCENE, not the different crops of their separate reference photos. Keep each head proportional to its own body; do not enlarge one person\'s head just because their reference is a close-up. Do not force both heads to identical sizes or assume body size from gender.');
    if(style.stylePrompt)instructions.push('Visual style: '+style.stylePrompt);
    return {references,prompt:instructions.join('\n\n')+'\n\nCURRENT SCENE:\n'+scene,skipped:false};
  }
  function recordFor(config, opts, plan) {
    const record = { time: Date.now(), entity: opts.faceLockTargetName || '生图', count: plan.references.length,
      mode: plan.references.length ? '带参考图' : '纯文字', skipped: plan.skipped, state: 'running',
      model: String(config.oaiModel || ''), message: '' };
    history.unshift(record); history.splice(12); notify(record); return record;
  }
  // Only simultaneous identical requests are coalesced; completed requests are never replayed from a cache.
  function fingerprint(value) { let h = 2166136261; for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619); return (h >>> 0).toString(16); }
  async function generate(prompt, config, artist, opts = {}) {
    const endpoint = String(config.oaiEndpoint || bridge.defaultEndpoint || '').trim().replace(/\/+$/, '').replace(/\/images\/(?:generations|edits)$/, '');
    const model = String(config.oaiModel || bridge.defaultModel || '').trim();
    if (!/^https?:\/\//i.test(endpoint)) throw new Error('请填写完整的生图接口地址，例如 https://你的站点/v1。');
    if (!String(config.oaiApiKey || '').trim()) throw new Error('请先填写生图 API Key。');
    const resultPlan = plan(prompt, config, artist, opts);
    const size = bridge.size(config.resolution, model);
    const field = config.oaiReferenceImageField === 'image[]' ? 'image[]' : 'image';
    const signature = JSON.stringify([endpoint, model, size, field, config.oaiApiKey, resultPlan]);
    const hash = fingerprint(signature);
    const running = pending.get(hash);
    if (running && running.signature === signature) return running.promise;
    const record = recordFor(config, opts, resultPlan);
    const promise = (async () => {
      try {
        const key = bridge.apiKey(config.oaiApiKey);
        let body, headers = { Authorization: 'Bearer ' + key };
        if (resultPlan.references.length) {
          body = new FormData();
          body.append('model', model); body.append('prompt', resultPlan.prompt); body.append('size', size); body.append('n', '1');
          resultPlan.references.forEach((ref, index) => {
            const blob = bridge.blob(ref.image), ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
            body.append(field, blob, `reference-${index + 1}-${ref.role}.${ext}`);
          });
        } else {
          const special = bridge.specialModel?.(endpoint, model);
          const payload = special ? { model, prompt: resultPlan.prompt, image_size: size, batch_size: 1, num_inference_steps: config.steps || 20 }
            : { model, prompt: resultPlan.prompt, size, n: 1 };
          if (special && config.oaiDefaultNegativePrompt) payload.negative_prompt = config.oaiDefaultNegativePrompt;
          if (special && /qwen/i.test(model)) payload.cfg = config.scale || 4;
          if (special && /kolors/i.test(model)) payload.guidance_scale = config.scale || 7.5;
          if (/dall-e/i.test(model)) payload.response_format = 'b64_json';
          body = JSON.stringify(payload); headers['Content-Type'] = 'application/json';
        }
        const proxy = { ...bridge.proxy(config), fallbackToDirect: false };
        const response = await bridge.fetch(endpoint + (resultPlan.references.length ? '/images/edits' : '/images/generations'), { method: 'POST', headers, body }, proxy);
        if (!response.ok) throw new Error(`接口返回 ${response.status}。${resultPlan.references.length ? '请检查模型是否支持参考图、图片字段格式及接口权限。' : '请检查模型、额度及接口设置。'}`);
        let data;
        try { data = await response.json(); } catch (_) { throw new Error('接口没有返回可识别的图片结果。'); }
        const image = await bridge.pick(data, proxy);
        if (!image) throw new Error('接口未返回可读取的图片；如站点使用异步任务接口，需要另行适配。');
        record.state = 'done'; record.message = record.count ? `已完成，提交了 ${record.count} 张参考图。` : '已完成，纯文字生成。';
        notify(record); return image;
      } catch (error) {
        record.state = 'failed';
        const known = error instanceof Error ? error.message : '';
        // Do not display response bodies or headers, which may echo provider credentials or private prompts.
        const safe = /^(接口返回 \d+|接口没有|接口未返回)/.test(known) ? known : '连接中断或图片读取失败，服务端可能仍在处理，请先查看站点记录。';
        record.message = (record.count ? '参考图生成失败：' : '生图失败：') + safe + ' 未自动重试，也未切换为纯文字生成。';
        notify(record); throw new Error(record.message);
      }
    })();
    pending.set(hash, { signature, promise });
    try { return await promise; } finally { if (pending.get(hash)?.promise === promise) pending.delete(hash); }
  }
  return { profileKey, maxIdentityImages, blank, validImage, cleanProfile, entities, find, profile, save, options, plan, planSubjects, generate, history,
    report(record) { if (!history.includes(record)) { history.unshift(record); history.splice(12); } notify(record); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    exportProfiles() { return { format: 'roche-native-image-references', version: bridge.exportPresetLibraries?4:3, profiles: entities().filter(e => e[profileKey]).map(e => ({ id: e.id, name: e.handle || e.name || '', profile: cleanProfile(e[profileKey]) })),...(bridge.exportPresetLibraries?{presetLibraries:bridge.exportPresetLibraries()}:{}) }; },
    async importProfiles(data) {
      if (data?.format !== 'roche-native-image-references' || ![1, 2, 3, 4].includes(data.version) || !Array.isArray(data.profiles) || data.profiles.length > 500) throw new Error('这不是本功能导出的参考设置文件。');
      const presetGroups=bridge.preparePresetImport?bridge.preparePresetImport(data.presetLibraries):[];
      const items = data.profiles.filter(item => find(item.id)).map(item => ({ id: item.id, profile: cleanProfile(item.profile) }));
      for (const item of items) await save(item.id, item.profile);
      const presetsSaved=bridge.importPresetLibraries?await bridge.importPresetLibraries(presetGroups):0;
      return { saved: items.length, skipped: data.profiles.length - items.length,presetsSaved };
    }
  };
}

function createRocheReferenceUI(engine, bridge) {
  let active = null, closeActive=null;
  const css = `
  .rr-overlay{position:fixed;inset:0;z-index:2147483500;background:#14141670;display:flex;align-items:center;justify-content:center;padding:24px;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#171719;box-sizing:border-box;color-scheme:light}
  .rr-panel{background:#fff;width:100%;max-width:620px;max-height:calc(100dvh - 48px);border-radius:24px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 80px #0003}
  .rr-panel *{box-sizing:border-box}.rr-head{padding:20px 24px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid #ededf0;background:#fff;flex-shrink:0}.rr-head h2{margin:0;font-size:20px;font-weight:700;color:#171719;line-height:1.3}
  .rr-body{padding:8px 24px 24px;overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;scrollbar-color:#c9c9ce transparent;scrollbar-width:thin}.rr-section{background:#f7f7f9;border:0;border-radius:16px;padding:18px;margin-bottom:16px}.rr-title{font-size:16px;font-weight:650;margin:0 0 8px}.rr-help{font-size:13px;line-height:1.6;color:#66666e;margin:8px 0 12px;overflow-wrap:anywhere}.rr-intro{margin:10px 0 20px}.rr-field{display:block;margin:18px 0 8px;font-size:14px;font-weight:600}
  .rr-panel input:not([type=checkbox]),.rr-panel select,.rr-panel textarea{width:100%;background:#fff;color:#171719;border:1px solid #e5e5e9;border-radius:12px;padding:12px;font:inherit;font-size:16px;min-height:46px;caret-color:#171719}.rr-panel input::placeholder,.rr-panel textarea::placeholder{color:#717179;opacity:1}.rr-panel textarea{resize:vertical;min-height:86px}.rr-panel input[type=checkbox]{width:20px;height:20px;accent-color:#171719;flex-shrink:0}.rr-check{display:flex;align-items:center;gap:10px;margin:0 0 8px;font-weight:600}.rr-panel button{font:inherit;cursor:pointer;min-height:44px;border-radius:999px;padding:10px 16px;border:0;color:#171719;background:#fff;touch-action:manipulation}.rr-panel button:disabled{color:#787880;background:#ededf0;cursor:default}.rr-panel button:focus-visible,.rr-panel input:focus-visible,.rr-panel select:focus-visible,.rr-panel textarea:focus-visible,.rr-panel summary:focus-visible{outline:2px solid #36363b;outline-offset:3px}.rr-panel .rr-primary{background:#0a0a0b;color:#fff}.rr-panel .rr-primary:disabled{background:#ededf0;color:#787880}.rr-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.rr-image{width:100%;max-height:180px;object-fit:contain;border-radius:12px;background:#ebebee;display:block;margin:10px 0}.rr-image[hidden]{display:none}.rr-reference-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:14px 0}.rr-identity-item{min-width:0}.rr-reference-grid .rr-image{height:160px;margin:0 0 8px;object-fit:contain;background:#eaeaee}.rr-reference-grid .rr-actions{gap:5px;flex-wrap:nowrap}.rr-reference-grid button{font-size:12px;padding:8px 9px;min-height:44px;flex:1;white-space:nowrap}.rr-reference-grid button[aria-pressed=true]{background:#171719;color:#fff}.rr-slot{border-top:1px solid #e5e5e9;padding-top:18px;margin-top:22px}.rr-status{white-space:pre-wrap;font-size:13px;color:#55555e;padding-top:4px;overflow-wrap:anywhere}.rr-status:empty{display:none}.rr-status[data-error=true]{color:#a12726}.rr-foot{background:#fff;border-top:1px solid #ededf0;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-shrink:0}.rr-foot small{color:#66666e;font-size:12px}.rr-log{font-size:13px;padding:12px 0;border-bottom:1px solid #e5e5e9;overflow-wrap:anywhere}.rr-panel details>summary{cursor:pointer;font-weight:600;min-height:32px;line-height:32px}.rr-panel details:not([open])>summary{min-height:44px;line-height:44px}.rr-panel .rr-hidden{display:none}.rr-panel input[type=file]{font-size:13px;margin:12px 0 8px;padding:8px}.rr-panel ::selection{background:#dedee5;color:#111}.rr-panel input[type=file]::file-selector-button{border:0;background:#eeeeF1;border-radius:999px;color:#171719;padding:7px 11px;margin-right:8px}
  @media(hover:hover){.rr-panel button:not(:disabled):hover{filter:brightness(.96)}}
  .rr-panel select{appearance:none;-webkit-appearance:none;background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24'%3E%3Cpath d='m7 10 5 5 5-5' fill='none' stroke='%2366666e' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 12px center;padding-right:38px}
  .rr-panel:focus{outline:none}
  @media(max-width:600px){.rr-overlay{padding:0;align-items:stretch}.rr-panel{max-height:100dvh;height:100dvh;border-radius:0}.rr-head{padding:calc(14px + env(safe-area-inset-top,0px)) 20px 14px}.rr-foot{padding:12px 20px calc(12px + env(safe-area-inset-bottom,0px))}.rr-body{padding:6px 20px 20px}.rr-section{padding:16px}.rr-reference-grid .rr-image{height:148px}}
  `;
  function el(tag, text, attrs = {}) { const node = document.createElement(tag); if (text != null) node.textContent = text; for (const [key, value] of Object.entries(attrs)) { if (key === 'class') node.className = value; else node.setAttribute(key, value); } return node; }
  function button(text, action, attrs = {}) { const b = el('button', text, { type: 'button', ...attrs }); b.addEventListener('click', action); return b; }
  async function readImage(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('请选择 PNG、JPEG 或 WEBP 图片。');
    if (file.size > 20 * 1024 * 1024) throw new Error('图片超过 20 MB，请先缩小再选择。');
    const url = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('文件读取失败。')); reader.readAsDataURL(file); });
    {
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('图片读取失败。')); image.src = url; });
      const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('浏览器无法处理图片。');
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.92);
      if (!engine.validImage(data)) throw new Error('处理后的图片仍过大，请换一张更小的图片。');
      return data;
    }
  }
  function open(config, preferredId) {
    if (active) { active.focus(); return; }
    if (!document.getElementById('roche-reference-style')) { const style = el('style', css, { id: 'roche-reference-style' }); document.head.append(style); }
    const overlay = el('div', null, { class: 'rr-overlay' }), panel = el('section', null, { class: 'rr-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'rr-heading', tabindex: '-1' });
    const previousFocus = document.activeElement, previousOverflow = document.body.style.overflow;
    let dirty = false, busy = false, uploading = 0, selectedId = '', draft = engine.blank();
    const head = el('header', null, { class: 'rr-head' }), body = el('div', null, { class: 'rr-body' }), footer = el('footer', null, { class: 'rr-foot' });
    const status = el('div', '', { class: 'rr-status', role: 'status', 'aria-live': 'polite' });
    const setStatus = (text, error = false) => { status.textContent = text; status.dataset.error = String(error); };
    function detach(){unsubscribe();overlay.remove();active=null;closeActive=null;document.body.style.overflow=previousOverflow;previousFocus?.focus?.();}
    function close() { if (busy || uploading) { setStatus('正在处理，请稍候再关闭。'); return; } if (dirty && !confirm('有未保存的参考设置，确定关闭吗？')) return; detach(); }
    closeActive=detach;
    head.append(el('h2', '人物与画风参考', { id: 'rr-heading' }), button('关闭', close, { 'aria-label': '关闭参考设置' }));
    body.append(el('p', bridge.pluginMode ? '长相跟随参考，穿着与神态跟随场景。' : '线上、线下共用人物参考。', { class: 'rr-help rr-intro' }));
    if(bridge.saveProtection){
      const protectionBox=el('details',null,{class:'rr-section'}),label=el('label',null,{class:'rr-check'}),check=el('input',null,{type:'checkbox',id:'rr-protection'});
      check.checked=bridge.protection();label.append(check,el('span','参考保护：绑定或请求异常时先暂停'));
      const note=el('p','绑定丢失、参考图损坏或请求来源冲突时先暂停。已绑定 user 的线下对话会自动区分出镜人物；明确无人或仅其他人物时可不带人物参考生成。不会因接口失败自动改成无参考图重试。仅覆盖经过本页的受支持请求；提交参考也不能保证人物完全一致。',{class:'rr-help'});
      const state=el('p',bridge.connectionStatus?.()||'',{class:'rr-help',role:'status'});
      check.addEventListener('change',async()=>{const value=check.checked;check.disabled=true;try{await bridge.saveProtection(value);state.textContent=value?'参考保护已开启。':'参考保护已关闭，未匹配参考的请求将按原生方式生成。';}catch{check.checked=bridge.protection();state.textContent='设置未保存，请重试。';}finally{check.disabled=false;}});
      protectionBox.append(el('summary','参考保护'),label,note,state);
      // Keep exceptional configuration below the main editing task.
      body.append(protectionBox);
    }
    const targetBox = el('div', null, { class: 'rr-section' }), target = el('select', null, { id: 'rr-target', 'aria-label': '选择角色或身份' });
    const list = engine.entities();
    for (const entity of list) target.append(el('option', (entity._rrKind === 'persona' ? '我的人设 · ' : '角色 · ') + (entity.handle || entity.name || entity.id), { value: entity.id }));
    if (preferredId && list.some(e => String(e.id) === String(preferredId))) target.value = preferredId;
    targetBox.append(el('label', '为谁设置', { class: 'rr-field', for: 'rr-target' }), target); body.append(targetBox);
    const presetsBox=el('details',null,{class:'rr-section',id:'rr-presets'}),presetSelect=el('select',null,{id:'rr-preset','aria-label':'参考预设'}),presetName=el('input',null,{id:'rr-preset-name',type:'text',maxlength:'80',placeholder:'给这套参考起个名字'}),presetInfo=el('p','',{class:'rr-help'});
    let selectedPresetId='';const presetButtons=[];
    const currentPresetInfo=el('p','',{class:'rr-help',id:'rr-current-preset'});
    function matchingPresets(){
      if(!bridge.presets||!selectedId)return [];
      const saved=JSON.stringify(engine.cleanProfile(engine.profile(selectedId)));
      return bridge.presets.list(selectedId).filter(item=>JSON.stringify(engine.cleanProfile(item.profile))===saved);
    }
    function restorePresetSelection(){
      const matches=matchingPresets();selectedPresetId=matches.length===1?matches[0].id:'';
      presetName.value=matches.length===1?matches[0].name:'';
    }
    function drawPresets(){
      if(!bridge.presets)return;
      const items=bridge.presets.list(selectedId);presetSelect.replaceChildren(el('option','选择已保存的预设',{value:''}));
      for(const item of items)presetSelect.append(el('option',item.name,{value:item.id}));
      if(!items.some(p=>p.id===selectedPresetId))selectedPresetId='';presetSelect.value=selectedPresetId;
      const chosen=items.find(p=>p.id===selectedPresetId);
      const saved=engine.profile(selectedId),matches=matchingPresets();
      currentPresetInfo.textContent=!saved.enabled?'当前参考设置：未启用。':matches.length?`当前已保存设置：与「${matches.map(p=>p.name).join('」「')}」一致。`:'当前已保存设置：自定义配置，与已存预设不同。';
      if(saved.enabled)currentPresetInfo.textContent+=` ${saved.identityImages.length} 张人物图${saved.styleImage?' + 1 张画风图':''}。`;
      if(dirty)currentPresetInfo.textContent+=' 下方有未保存的修改，尚未用于生图。';
      const binding=bridge.bindingStatus?.(selectedId);if(binding)currentPresetInfo.textContent+=' '+binding;
      presetInfo.textContent=chosen?`${chosen.profile.identityImages.length} 张人物图 · ${chosen.profile.primaryIndices.length} 张主参考${chosen.profile.styleImage?' · 含画风图':''}。点击「套用并保存」切换整套设置。`:`此角色已保存 ${items.length} / ${bridge.presets.maxPresets} 个预设。选择预设不会立即切换；保存新预设也不会覆盖当前生图设置。`;
      presetButtons.forEach(b=>b.disabled=busy||(!selectedPresetId&&b.dataset.needsPreset==='true'));
    }
    async function presetTask(action){
      if(busy||uploading||!selectedId)return;
      busy=true;saveButton.disabled=true;target.disabled=true;editor.inert=true;presetSelect.disabled=true;presetName.disabled=true;presetButtons.forEach(b=>b.disabled=true);
      try{await action();}catch(error){setStatus(error.message,true);}finally{busy=false;saveButton.disabled=false;target.disabled=false;editor.inert=false;presetSelect.disabled=false;presetName.disabled=false;drawPresets();}
    }
    if(bridge.presets){
      presetsBox.append(el('summary','造型预设'),currentPresetInfo,el('label','已保存的预设',{class:'rr-field',for:'rr-preset'}),presetSelect,presetInfo,el('label','预设名称',{class:'rr-field',for:'rr-preset-name'}),presetName);
      presetSelect.addEventListener('change',()=>{selectedPresetId=presetSelect.value;presetName.value=bridge.presets.list(selectedId).find(p=>p.id===selectedPresetId)?.name||'';drawPresets();});
      const actions=el('div',null,{class:'rr-actions'});
      const add=button('保存为新预设',()=>presetTask(async()=>{const item=await bridge.presets.put(selectedId,{name:presetName.value,profile:draft});selectedPresetId=item.id;presetName.value=item.name;setStatus('预设已保存。要用于后续生图，点击「套用并保存」。');}),{id:'rr-preset-add'});
      const update=button('更新所选预设',()=>presetTask(async()=>{const item=await bridge.presets.put(selectedId,{id:selectedPresetId,name:presetName.value,profile:draft});presetName.value=item.name;setStatus('所选预设已更新。当前生图设置仍以最近一次「保存参考设置」或「套用并保存」为准。');}),{id:'rr-preset-update','data-needs-preset':'true'});
      const apply=button('套用并保存',()=>{
        if(busy||uploading)return;const item=bridge.presets.list(selectedId).find(p=>p.id===selectedPresetId);if(!item)return;
        if(dirty&&!confirm('当前有未保存的参考修改，套用预设会替换这些修改。继续？'))return;
        presetTask(async()=>{const saved=await engine.save(selectedId,item.profile);draft=saved;dirty=false;footerNote.textContent='已保存';drawEditor();setStatus(`已套用「${item.name}」。后续生图使用这套参考。请确认 Roche 原来的绘图预设也对应当前造型。`);});
      },{id:'rr-preset-apply',class:'rr-primary','data-needs-preset':'true'});
      const remove=button('删除预设',()=>{
        if(busy||uploading)return;const item=bridge.presets.list(selectedId).find(p=>p.id===selectedPresetId);if(!item||!confirm(`删除预设「${item.name}」？当前已保存的生图参考设置会保留。`))return;
        presetTask(async()=>{await bridge.presets.remove(selectedId,item.id);selectedPresetId='';presetName.value='';setStatus('已删除预设。');});
      },{id:'rr-preset-remove','data-needs-preset':'true'});
      presetButtons.push(add,update,apply,remove);actions.append(add,update,apply,remove);presetsBox.append(actions);body.append(presetsBox);
    }
    const editor = el('div', null, { class: 'rr-section' }); body.append(editor);
    body.insertBefore(editor,body.contains(presetsBox)?presetsBox:null);
    const mark = () => { dirty = true; footerNote.textContent = '有未保存的修改'; drawPresets(); };
    function drawEditor() {
      drawPresets();
      editor.replaceChildren();
      if (!selectedId) { editor.append(el('p', '请先在 Roche 中创建角色或身份，再来添加参考图。', { class: 'rr-help' })); return; }
      const enableLabel = el('label', null, { class: 'rr-check' }), enabled = el('input', null, { type: 'checkbox', id: 'rr-enabled' }); enabled.checked = draft.enabled;
      enabled.addEventListener('change', () => { draft.enabled = enabled.checked; mark(); });
      enableLabel.append(enabled, el('span', '启用这套参考设置')); editor.append(enableLabel);
      editor.append(el('p', bridge.pluginMode ? (engine.find(selectedId)?._rrKind==='persona'?'保存到此人设，线下聊天自动读取；不用在每个角色里重复上传。':'单人最多 4 张；双人每人最多 2 张，优先取主参考。') : '使用此人的参考图生成。', { class: 'rr-help' }));
      if(bridge.pluginMode&&engine.find(selectedId)?._rrKind==='contact'){
        const pair=el('select',null,{id:'rr-paired-persona'});
        pair.append(el('option','跟随当前聊天人设（推荐）',{value:'auto'}),el('option','不使用 user 参考',{value:'off'}));
        const users=engine.entities().filter(e=>e._rrKind==='persona');
        for(const p of users)pair.append(el('option',p.name||p.handle||p.id,{value:p.id}));
        if(draft.pairedPersonaId&&!users.some(p=>String(p.id)===draft.pairedPersonaId))pair.append(el('option','原 user 已不存在，请重新选择',{value:draft.pairedPersonaId}));
        pair.value=draft.userSource==='fixed'?draft.pairedPersonaId:draft.userSource;
        const pairStatus=el('p','',{class:'rr-help',id:'rr-pair-status'});
        const updatePairStatus=()=>{const p=users.find(p=>String(p.id)===pair.value),refs=p&&engine.profile(p.id);pairStatus.textContent=pair.value==='auto'?'只在 user 出镜时使用该聊天人设的参考；线上不追加 user。':pair.value==='off'?'线下只辅助角色，不追加 user。':refs?.enabled&&refs.identityImages.length?`固定使用 ${p.name||p.handle} · ${refs.identityImages.length} 张参考`:'请先为此人设添加、启用并保存参考图。';};
        pair.addEventListener('change',()=>{draft.userSource=['auto','off'].includes(pair.value)?pair.value:'fixed';draft.pairedPersonaId=draft.userSource==='fixed'?pair.value:'';updatePairStatus();mark();});updatePairStatus();
        const pairBox=el('details',null,{class:'rr-slot',id:'rr-user-settings'});pairBox.append(el('summary','线下的我'),el('label','使用哪套人设参考',{class:'rr-field',for:'rr-paired-persona'}),pair,pairStatus);editor.append(pairBox);
        const unnamedSolo=el('select',null,{id:'rr-offline-unnamed-solo'});
        for(const [value,label] of [['auto','自动；未标记的人物场景按本角色辅助'],['character','默认使用本聊天角色的参考'],['user','默认使用绑定 user 的参考']])unnamedSolo.append(el('option',label,{value}));
        unnamedSolo.value=draft.offlineUnnamedSolo;
        unnamedSolo.addEventListener('change',()=>{draft.offlineUnnamedSolo=unnamedSolo.value;mark();});
        pairBox.append(el('label','未标记的单人场景',{class:'rr-field',for:'rr-offline-unnamed-solo'}),unnamedSolo);
      }
      function slot(key, title, hint) {
        const section = el('div', null, { class: 'rr-slot' }); section.append(el('h3', title, { class: 'rr-title' }), el('p', hint, { class: 'rr-help' }));
        const preview = el('img', null, { class: 'rr-image', alt: title + '预览' }); if (draft[key]) preview.src = draft[key]; preview.hidden = !draft[key];
        const file = el('input', null, { type: 'file', accept: 'image/png,image/jpeg,image/webp', 'aria-label': '上传' + title, id: 'rr-' + key });
        file.addEventListener('change', async () => { const chosen = file.files[0]; if (!chosen) return; const id = selectedId; uploading++; saveButton.disabled = true; target.disabled = true;
          try { const data = await readImage(chosen); if (selectedId === id) { draft[key] = data; preview.src = data; preview.hidden = false; mark(); setStatus('图片已准备好，请保存。'); } }
          catch (error) { setStatus(error.message, true); } finally { uploading--; saveButton.disabled = busy; target.disabled = busy; file.value = ''; }
        });
        const actions = el('div', null, { class: 'rr-actions' }); actions.append(button('移除', () => { draft[key] = ''; preview.removeAttribute('src'); preview.hidden = true; mark(); }));
        if (key === 'identityImage') actions.append(button('使用原锁脸图', () => { const image = bridge.legacyImage(selectedId); if (!image) return setStatus('这个角色还没有可用的原锁脸图。', true); draft[key] = image; preview.src = image; preview.hidden = false; mark(); }));
        section.append(preview, file, actions); editor.append(section);
      }
      const identities = el('div', null, { class: 'rr-slot' });
      identities.append(el('h3', `人物参考 · ${draft.identityImages.length} / ${engine.maxIdentityImages}`, { class: 'rr-title' }), el('p', '单人会提交全部人物图。主参考可多选，原生锁脸中的一张只是连接入口。', { class: 'rr-help' }));
      const grid=el('div',null,{class:'rr-reference-grid'});identities.append(grid);
      draft.identityImages.forEach((image, index) => {
        const item = el('div', null, { class: 'rr-identity-item' });
        const primary = draft.primaryIndices.includes(index);
        item.append(el('img', null, { class: 'rr-image', alt: `人物参考图 ${index + 1}`, src: image }));
        const actions = el('div', null, { class: 'rr-actions' });
        actions.append(button(primary ? '主参考' : '辅助参考', () => { if (busy || uploading) return; if(primary && draft.primaryIndices.length === 1) return setStatus('至少保留一张主参考，请先将另一张加入主参考。'); draft.primaryIndices = primary ? draft.primaryIndices.filter(i=>i!==index) : [...draft.primaryIndices,index].sort((a,b)=>a-b); mark(); drawEditor(); }, {'data-rr-primary-index':String(index),'aria-pressed':String(primary),'aria-label':primary?'改为辅助参考':'加入主参考'}));
        actions.append(button('移除', () => { if (busy || uploading) return; draft.identityImages.splice(index, 1); draft.primaryIndices=draft.primaryIndices.filter(i=>i!==index).map(i=>i>index?i-1:i); if(draft.identityImages.length&&!draft.primaryIndices.length)draft.primaryIndices=[0]; mark(); drawEditor(); },{'aria-label':`移除第 ${index+1} 张`}));
        item.append(actions); grid.append(item);
      });
      const files = el('input', null, { type: 'file', multiple: '', accept: 'image/png,image/jpeg,image/webp', 'aria-label': '添加人物参考图（可多选）', id: 'rr-identityImages' });
      files.disabled = draft.identityImages.length >= engine.maxIdentityImages;
      files.addEventListener('change', async () => {
        if (busy || uploading) return;
        const selected = [...files.files]; if (!selected.length) return;
        if (selected.length + draft.identityImages.length > engine.maxIdentityImages) { files.value = ''; return setStatus('人物参考图最多 4 张，请减少本次选择或先移除已有图片。', true); }
        uploading++; saveButton.disabled = true; target.disabled = true; files.disabled = true;
        try {
          const prepared = [];
          for (const file of selected) prepared.push(await readImage(file));
          const start=draft.identityImages.length; draft.identityImages.push(...prepared); draft.primaryIndices.push(...prepared.map((_,i)=>start+i)); mark(); drawEditor();
          setStatus(`已添加 ${prepared.length} 张人物图，请保存。`);
        } catch (error) { setStatus(error.message + ' 本次所选图片均未添加。', true); }
        finally { uploading--; saveButton.disabled = busy; target.disabled = busy; files.value = ''; files.disabled = draft.identityImages.length >= engine.maxIdentityImages; }
      });
      identities.append(files, button('添加原锁脸图', () => {
        if (busy || uploading) return;
        if (draft.identityImages.length >= engine.maxIdentityImages) return setStatus('已达 4 张上限，请先移除一张。', true);
        const image = bridge.legacyImage(selectedId);
        if (!engine.validImage(image)) return setStatus('这个角色没有可用的原锁脸图。', true);
        if (draft.identityImages.includes(image)) return setStatus('原锁脸图已经在参考列表中。');
        draft.primaryIndices.push(draft.identityImages.length); draft.identityImages.push(image); mark(); drawEditor();
      }));
      editor.append(identities);
      const pairBox=editor.querySelector('#rr-user-settings');if(pairBox)editor.append(pairBox);
      const qualityBox=el('div',null,{class:'rr-slot'}),natural=el('select',null,{id:'rr-natural-mode','aria-label':'人物表现'});
      natural.append(el('option','自然变化（推荐）',{value:'natural'}),el('option','更贴近参考长相',{value:'faithful'}));natural.value=draft.referenceMode;
      natural.addEventListener('change',()=>{draft.referenceMode=natural.value;mark();});
      const height=el('input',null,{type:'number',inputmode:'numeric',min:'80',max:'250',step:'1',id:'rr-height',placeholder:'可选 · cm'});height.value=draft.heightCm||'';
      height.addEventListener('input',()=>{draft.heightCm=height.value?Number(height.value):0;mark();});
      qualityBox.append(el('label','人物表现',{class:'rr-field',for:'rr-natural-mode'}),natural,el('label','身高',{class:'rr-field',for:'rr-height'}),height,el('p','只约束长相与合理体态；不会固定参考图的衣服、姿势和表情。身高仅作构图提示，不能保证比例。',{class:'rr-help'}));editor.append(qualityBox);
      const mode = el('select', null, { id: 'rr-mode' }); mode.append(el('option', '自动：场景明确有人物时补图', { value: 'auto' }), el('option', '始终使用人物图（已确认本角色的生成）', { value: 'always' })); mode.value = draft.identityMode;
      mode.addEventListener('change', () => { draft.identityMode = mode.value; mark(); }); editor.append(el('label', '人物图使用方式', { class: 'rr-field', for: 'rr-mode' }), mode);
      const more=el('details',null,{class:'rr-slot',id:'rr-more'});more.append(el('summary','外貌、画风与识别设置'));editor.append(more);more.append(editor.querySelector('label[for="rr-mode"]'),mode);
      function textField(key, title, placeholder) { const input = el('textarea', null, { id: 'rr-' + key, maxlength: '4000', placeholder }); input.value = draft[key]; input.addEventListener('input', () => { draft[key] = input.value; mark(); }); more.append(el('label', title, { class: 'rr-field', for: 'rr-' + key }), input); }
      if(bridge.pluginMode){textField('subjectAliases','图片场景中的其他称呼（可选，旧式描述辅助）','例如：Ghost 或 Z。多个称呼用逗号分开，填写实际昵称，不要填“男人”“女人”等泛称。');editor.querySelector('#rr-subjectAliases').maxLength=500;}
      textField('appearance', '固定外貌', '例如：棕色眼睛、短发、下颌轮廓。这里只写长期不变的特征。');
      slot('styleImage', '画风参考图（可选）', '只参考色调、光线和质感；人物长相仍以人物图为准。站点需要支持多张参考图。');
      more.append(editor.lastElementChild);
      textField('stylePrompt', '固定画风（可选）', '例如：自然摄影、柔和光线、真实皮肤纹理。');
      const guide=el('details',null,{class:'rr-slot'});guide.append(el('summary','怎样选图更自然'),el('p','用同一个人的正面、侧面或 3/4 侧面，加一张半身图。前两张主参考尽量角度不同、清晰且不过度广角；双人图优先取它们。避开四张几乎相同的自拍、夸张大头裁切和混用不同面罩款式。',{class:'rr-help'}),el('p','固定外貌只写肤色、眼睛、脸型、发色、身高、纹身或必要的面罩特征。衣服、动作、神情和灯光交给本轮场景；原绘图前缀里也请移除固定服装和固定表情。参考图不能保证模型每次完全一致。',{class:'rr-help'}));editor.append(guide);
    }
    const adapterBox = el('details', null, { class: 'rr-section' }); adapterBox.append(el('summary', '接口兼容设置'));
    const field = el('select', null, { id: 'rr-field' }); field.append(el('option', 'image — FoxAPI 文档中的写法', { value: 'image' }), el('option', 'image[] — 部分兼容站的多图写法', { value: 'image[]' })); field.value = config.oaiReferenceImageField === 'image[]' ? 'image[]' : 'image';
    field.addEventListener('change', async () => { const old = config.oaiReferenceImageField; try { await bridge.saveField?.(field.value); config.oaiReferenceImageField = field.value; setStatus('接口图片字段已保存。'); } catch (_) { field.value = old || 'image'; setStatus('字段未保存，请重试。', true); } });
    adapterBox.append(el('label', '图片上传字段', { class: 'rr-field', for: 'rr-field' }), field, el('p', '沿用生图配置中的地址、模型和密钥。不会自动探测、试扣费或失败重发。换站后按该站文档选择字段。', { class: 'rr-help' })); if(bridge.saveResultMode){
      const format=el('select',null,{id:'rr-result-mode'});format.append(el('option','优先返回图片数据（推荐）',{value:'embedded'}),el('option','沿用接口返回格式',{value:'native'}));format.value=bridge.resultMode?.()||'embedded';
      format.addEventListener('change',async()=>{const old=bridge.resultMode?.()||'embedded';try{await bridge.saveResultMode(format.value);setStatus('图片保存方式已保存。');}catch{format.value=old;setStatus('保存失败，请重试。',true);}});
      adapterBox.append(el('label','生成图片保存方式',{class:'rr-field',for:'rr-result-mode'}),format,el('p','直接返回图片数据，交给 Roche 保存并上传到已配置的图床。兼容站若明确报 response_format 不支持，可改为沿用接口格式；不会自动重发付费请求。外部链接下载失败会提示。',{class:'rr-help'}));
    }body.append(adapterBox);
    const testBox = el('details', null, { class: 'rr-section' }), testPrompt = el('textarea', null, { 'aria-label': '测试场景', placeholder: '例如：这个人在窗边喝咖啡，半身自然光照片。', id: 'rr-test-prompt' });
    const result = el('img', null, { class: 'rr-image', alt: '本次测试生成结果' }); result.hidden = true;
    const testButton = button('测试生成 1 张（会扣费）', async () => {
      if (busy || uploading) return;
      if (!selectedId || !testPrompt.value.trim()) return setStatus('请先选择角色并填写测试场景。', true);
      if (!config.enabled || config.imageProvider !== 'openai') return setStatus('请先在生图配置中启用 OAI Format。', true);
      if (!confirm('将使用当前生图接口生成 1 张图片，会按站点规则扣费。确认开始？')) return;
      busy = true; testButton.disabled = true; saveButton.disabled = true; target.disabled = true; setStatus('正在生成，请勿重复提交……');
      try { const entity = engine.find(selectedId); const image = await engine.generate(testPrompt.value.trim(), config, '', { rocheReferenceProfile: engine.cleanProfile(draft), faceLockEntityId: selectedId, faceLockTargetName: entity?.handle || entity?.name || '' }); if (!image) throw new Error('未返回图片。'); result.src = image; result.hidden = false; setStatus('测试完成。确认满意后，保存角色参考设置。'); }
      catch (error) { setStatus(error.message, true); } finally { busy = false; testButton.disabled = false; saveButton.disabled = false; target.disabled = false; }
    });
    testBox.append(el('summary', '测试效果'), el('p', '仅点击并确认后才会请求生图。测试使用当前未保存的编辑内容，不写入聊天记录。', { class: 'rr-help' }), testPrompt, testButton, result); if (!bridge.pluginMode) body.append(testBox);
    const logsBox = el('details', null, { class: 'rr-section',id:'rr-generation-checks' }), logs = el('div'); logsBox.open=engine.history.some(row=>row.kind==='offline-check');
    const copyHint=el('p','',{class:'rr-help',role:'status','aria-live':'polite',id:'rr-copy-status'});
    const copyText=el('textarea',null,{readonly:'',rows:'7','aria-label':'可手动复制的检查结果',id:'rr-copy-text',style:'user-select:text;-webkit-user-select:text;touch-action:auto'});copyText.hidden=true;
    function selectCheckText(){copyText.focus();copyText.select();copyText.setSelectionRange(0,copyText.value.length);}
    const selectCopy=button('全选检查文字',selectCheckText,{id:'rr-select-check-text'});selectCopy.hidden=true;
    logsBox.append(el('summary', '最近生成状态／线下生图检查'),el('p','线下正常聊一轮后，在这里看「线下触发检查」。它只检查当前页面经过的请求和回复，不额外调用模型。本机保留最近 12 条检查摘要，最长 7 天；不保存图片副本。',{class:'rr-help'}),button('复制生成与检查记录',async()=>{
      const rows=engine.history;
      if(!rows.length){copyText.hidden=true;selectCopy.hidden=true;copyText.value='';copyHint.textContent='暂时没有生成或检查记录，暂无内容可复制。';return;}
      const text=rows.map(row=>[new Date(row.time).toLocaleString()+' · '+(row.mode||'生成记录'),row.state==='blocked'?'已暂停，未提交':row.state==='running'?'进行中':row.state==='done'?'完成':'失败或未完成',row.presetLabel?'本次配置：'+row.presetLabel:'',Number.isFinite(row.count)?'参考图：'+row.count+' 张':'',row.message].filter(Boolean).join('\n')).join('\n\n');
      copyText.value=text;copyText.hidden=false;selectCopy.hidden=false;
      copyHint.textContent='检查文字已显示在下方，可长按文字选择并复制。';
      // Call during the click gesture; the visible readonly field also works without clipboard permission.
      try{await navigator.clipboard.writeText(text);copyHint.textContent='已复制，可发回本聊天；下方也可手动选择复制。';}catch{copyHint.textContent='自动复制不可用：点「全选检查文字」，再长按选中文字，选择「复制」。';}
    },{id:'rr-copy-offline-check'}),copyHint,copyText,selectCopy,logs); body.append(logsBox);
    function renderLogs() {
      logs.replaceChildren();
      if (!engine.history.length) logs.append(el('p', '尚未记录到请求。没有记录不能证明使用了哪套图。', { class: 'rr-help' }));
      for(const row of engine.history){
        const item=el('div',null,{class:'rr-log'});
        item.append(el('p',new Date(row.time).toLocaleString()+' · '+row.entity+' · '+row.mode+' · '+(row.state==='blocked'?'已暂停，未提交':row.kind==='offline-check'?(row.state==='running'?'检查中':row.state==='done'?'检查完成':'检查未完成'):(row.state==='running'?'生成中':row.state==='done'?'完成':'失败或未完成'))));
        if(row.presetLabel)item.append(el('p','本次配置：'+row.presetLabel));
        if(row.source)item.append(el('p','角色确认依据：'+row.source));
        item.append(el('p',row.message+(row.skipped?' 本场景跳过了人物参考。':''),{style:'white-space:pre-wrap'}));
        if(row.references||row.prompt){
          const details=el('details',null,{'data-rr-request-details':'true'});details.append(el('summary','查看本次提交的参考图和提示词'));
          details.append(el('p','以下是插件提交给接口的内容，可核对参考图和面罩、头发描述。接口返回成功不代表模型严格采用了每张图。内容仅留在本次页面内存中。',{class:'rr-help'}));
          (row.references||[]).forEach((ref,index)=>{details.append(el('p','第 '+(index+1)+' 张 · '+(ref.subjectName?ref.subjectName+' · ':'')+(ref.role==='style'?'画风图':ref.primary?'主参考':'辅助参考')),el('img',null,{class:'rr-image',src:ref.image,alt:'本次提交的参考图 '+(index+1)}));});
          details.append(el('p','实际提交的提示词',{class:'rr-field'}));const text=el('textarea',null,{readonly:'',rows:'6','aria-label':'实际提交的提示词'});text.value=row.prompt||'';details.append(text);item.append(details);
        }
        logs.append(item);
      }
    }
    const unsubscribe = engine.subscribe(renderLogs); renderLogs();
    const backups = el('details', null, { class: 'rr-section' }), importFile = el('input', null, { type: 'file', accept: '.json,application/json', class: 'rr-hidden' });
    backups.append(el('summary','参考设置备份'),el('p','参考图保存在当前浏览器，普通 Roche 备份不包含此插件的图片。换设备前请单独导出。导入按档案 ID 匹配，覆盖对应参考和预设。',{class:'rr-help'}));
    const backupActions = el('div', null, { class: 'rr-actions' });
    backupActions.append(button('导出参考设置', () => { if(busy||uploading)return setStatus('请等待当前操作完成后再导出。'); const url = URL.createObjectURL(new Blob([JSON.stringify(engine.exportProfiles())], { type: 'application/json' })); const a = el('a', '', { href: url, download: 'Roche_人物画风参考.json' }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }), button('导入参考设置', () => { if(busy||uploading)return; if (dirty) return setStatus('请先保存当前修改，再导入备份。', true); importFile.click(); }));
    importFile.addEventListener('change', async () => { if(busy||uploading)return; const file = importFile.files[0]; if (!file) return; if (file.size > 150 * 1024 * 1024) return setStatus('备份文件过大。', true); try { const data = JSON.parse(await file.text()); if (data.format !== 'roche-native-image-references') throw new Error('请选择本功能导出的参考设置文件。'); if (!confirm('导入会覆盖 ID 匹配角色的参考设置，以及备份中包含的对应角色预设库，不修改聊天记录。继续？')) return; await presetTask(async()=>{const result = await engine.importProfiles(data); draft = engine.profile(selectedId);restorePresetSelection();drawEditor(); setStatus(`已恢复 ${result.saved} 个角色、${result.presetsSaved||0} 个预设，跳过 ${result.skipped} 个未匹配角色。`);}); } catch (error) { setStatus(error.message, true); } finally { importFile.value = ''; } });
    backups.append(backupActions, importFile); body.append(backups, status);
    const protectionSection=body.querySelector('details:has(#rr-protection)');if(protectionSection)body.insertBefore(protectionSection,adapterBox);
    const footerNote = el('small', '未修改'), saveButton = button('保存参考设置', async () => { if (busy || uploading || !selectedId) return; busy = true; saveButton.disabled = true; target.disabled = true; editor.inert=true;presetSelect.disabled=true;presetName.disabled=true;try { draft = await engine.save(selectedId, draft); dirty = false; footerNote.textContent = '已保存'; restorePresetSelection();drawPresets(); setStatus(bridge.pluginMode ? '已保存。可回到原聊天或相册生成，之后在本面板查看提交张数。' : '已保存。该角色下一次原生生图会使用这套设置。'); } catch (error) { setStatus('保存失败：' + error.message, true); } finally { busy = false; saveButton.disabled = false; target.disabled = false;editor.inert=false;presetSelect.disabled=false;presetName.disabled=false;drawPresets(); } }, { class: 'rr-primary', id: 'rr-save' });
    footer.append(footerNote, saveButton);
    target.addEventListener('change', () => { if (dirty && !confirm('当前角色的修改还未保存，放弃修改并切换？')) { target.value = selectedId; return; } selectedId = target.value;draft = engine.profile(selectedId);restorePresetSelection(); dirty = false; footerNote.textContent = '未修改'; drawEditor(); setStatus(''); });
    selectedId = target.value; draft = selectedId ? engine.profile(selectedId) : engine.blank(); restorePresetSelection();drawEditor();
    panel.append(head, body, footer); overlay.append(panel); document.body.append(overlay); document.body.style.overflow = 'hidden'; active = panel; panel.focus();
    overlay.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } if (event.key === 'Tab') { const nodes = [...panel.querySelectorAll('button,input,select,textarea,a[href]')].filter(n => !n.disabled && n.getClientRects().length); const first = nodes[0], last = nodes[nodes.length - 1]; if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } } });
  }
  return { open,dispose(){closeActive?.();} };
}

// Cast information travels with the native image directive. No extra model call.
const referenceCastInstruction = `[ROCHE_REFERENCE_CAST_V1]
仅补充原生 [图片] 描述的元信息，不改变剧情、角色设定、回复格式或图片触发频率。
每条 [图片] 描述末尾自动加一个 [[RR:...]]，表示这张画面中实际可见的人物：char=本线下对话【参与角色列表】中的主角色；user=上文 User 本人；other=任何其他人物（同事、朋友、路人等）。不是整段剧情提到的人，拍摄者、回忆和画外人物不算出镜。
只允许这些写法：[[RR:char]]、[[RR:user]]、[[RR:char,user]]、[[RR:char,other]]、[[RR:user,other]]、[[RR:char,user,other]]、[[RR:other]]、[[RR:none]]。无人风景/物品用 none。多人不等于 user 在场，不能凭 1boy/1girl 或两个人就添加 user。
图片描述仍按原生要求用英文。自动在对应人物描写前用 main character 或 user 指明谁是谁；其他人物用自己的名字/特征。保留原生 [图片] 标签，元信息与描述放同一行，普通剧情正文不显示元信息。不要让用户手填这些内容。`;

function referenceSceneCast(raw) {
  const text=String(raw||''),matches=[...text.matchAll(/\[\[RR:([^\]\r\n]*)\]\]/gi)];
  const scene=text.replace(/\[\[RR:[^\]\r\n]*\]\]/gi,'').trim();
  if(matches.length!==1)return {scene,cast:null};
  const cast=[...new Set(matches[0][1].toLowerCase().split(',').map(s=>s.trim()))];
  if(!cast.length||cast.some(s=>!['char','user','other','none'].includes(s))||cast.includes('none')&&cast.length!==1)return {scene,cast:null};
  return {scene,cast};
}

async function referenceAnnotateOfflineRequest(input,init){
  const req=input instanceof Request?input:null;
  const raw=init?.body===undefined&&req?await req.clone().text():init?.body;
  if(typeof raw!=='string'||raw.length>8*1024*1024)return null;
  let data;try{data=JSON.parse(raw);}catch{return null;}
  const text=v=>typeof v==='string'?v:Array.isArray(v)?v.filter(p=>p?.type==='text').map(p=>p.text||'').join('\n'):'';
  const append=v=>typeof v==='string'?v+'\n\n'+referenceCastInstruction:[...(Array.isArray(v)?v:[]),{type:'text',text:referenceCastInstruction}];
  function edit(v,depth=0){
    if(!v||typeof v!=='object'||depth>3)return false;
    if(Array.isArray(v.messages)){
      const systems=[text(v.system),...v.messages.filter(m=>m?.role==='system'||m?.role==='developer').map(m=>text(m.content))];
      if(!systems.some(s=>s.includes('你正在进行“线下见面模式”'))||!systems.some(s=>s.includes('【图片生成/NovelAI Instructions】'))||systems.some(s=>s.includes('[ROCHE_REFERENCE_CAST_V1]')))return false;
      if(v.system!==undefined)v.system=append(v.system);
      else {const instruction=v.messages.find(m=>(m?.role==='system'||m?.role==='developer')&&text(m.content).includes('【图片生成/NovelAI Instructions】'));instruction.content=append(instruction.content);}
      return true;
    }
    if(v.payload&&edit(v.payload,depth+1))return true;
    if(v.body){
      if(typeof v.body!=='string')return edit(v.body,depth+1);
      try{
        const decoded=v.bodyEncoding==='base64'?new TextDecoder().decode(Uint8Array.from(atob(v.body),c=>c.charCodeAt(0))):v.body;
        const child=JSON.parse(decoded);if(!edit(child,depth+1))return false;
        const encoded=JSON.stringify(child);
        v.body=v.bodyEncoding==='base64'?btoa(Array.from(new TextEncoder().encode(encoded),b=>String.fromCharCode(b)).join('')):encoded;
        return true;
      }catch{return false;}
    }
    return false;
  }
  if(!edit(data))return null;
  const headers=new Headers(init?.headers||req?.headers);headers.delete('content-length');
  const next={...init,headers,body:JSON.stringify(data)};
  return req?{input:new Request(req,next),init:undefined}:{input,init:next};
}

function createOfflineImageCheck({report,prepareRequest}) {
  let active=true;
  const checks=new Set(),events=[],readers=new Set(),timers=new Set(),backend=new Map();
  const emit=row=>{if(active)report(row);};
  const contentText=value=>typeof value==='string'?value:Array.isArray(value)?value.filter(p=>p?.type==='text'||p?.type==='output_text').map(p=>typeof p.text==='string'?p.text:'').join(''):'';
  function payloadAt(value,depth=0){
    if(!value||typeof value!=='object'||depth>3)return null;
    if(Array.isArray(value.messages))return value;
    if(value.payload)return payloadAt(value.payload,depth+1);
    if(value.body){
      try{return payloadAt(typeof value.body==='string'?JSON.parse(value.bodyEncoding==='base64'?new TextDecoder().decode(Uint8Array.from(atob(value.body),c=>c.charCodeAt(0))):value.body):value.body,depth+1);}catch{}
    }
    return null;
  }
  function summary(row){
    const check=row.offlineCheck;
    const lines=['本轮请求：'+(check.requirement?'包含 Roche 原生「每轮生图」要求。':'未找到 Roche 原生「每轮生图」要求。')];
    if(!check.replyChecked)lines.push(check.responseNote||'正在检查模型返回内容……');
    else if(check.validDirectives)lines.push('模型回复：检测到 '+check.validDirectives+' 条有内容的原生 [图片] 指令。');
    else{
      lines.push('模型回复：没有检测到有内容的原生 [图片] 指令。');
      if(check.emptyDirectives)lines.push('发现空的 [图片] 标签。');
      if(check.alternativeFormat)lines.push('发现其他图片标签写法，Roche 可能无法按原生格式识别。');
    }
    if(check.finishReason==='length'||check.finishReason==='max_tokens')lines.push('接口表示回复达到长度上限，末尾图片指令可能尚未输出。');
    if(check.imageRequest)lines.push('后续请求：已观察到与该图片描述匹配的'+check.imageRequest+'。具体成功或失败请看对应生图记录。');
    else if(check.replyChecked&&check.validDirectives)lines.push('后续请求：尚未观察到匹配的生图请求。这项检查不会代替 Roche 发起生成。');
    row.message=lines.join('\n');emit(row);
  }
  function associate(row){
    if(!row.scenes?.length)return;
    const match=events.find(e=>e.time>=row.time&&e.time-row.time<180000&&row.scenes.some(scene=>e.prompt.includes(scene)));
    if(match)row.offlineCheck.imageRequest=match.kind;
  }
  function noteImage(prompt,kind){
    if(!active||typeof prompt!=='string')return;
    events.unshift({time:Date.now(),prompt,kind});events.splice(24);
    for(const row of checks){associate(row);summary(row);}
  }
  async function inspect(input,init){
    if(!active)return null;
    const req=input instanceof Request?input:null,url=typeof input==='string'?input:input instanceof URL?input.href:req?.url;
    if(!url)return null;
    const method=String(init?.method||req?.method||'GET').toUpperCase();
    if(method==='GET')return backend.get(new URL(url,location.href).href)||null;
    if(method!=='POST')return null;
    let body=init?.body;
    if(body===undefined&&req&&req.headers.get('content-type')?.includes('application/json'))body=await req.clone().text();
    if(typeof body!=='string'||body.length>8*1024*1024)return null;
    let envelope;try{envelope=JSON.parse(body);}catch{return null;}
    const payload=payloadAt(envelope);if(!payload)return null;
    const systems=[contentText(payload.system),...payload.messages.filter(m=>m?.role==='system'||m?.role==='developer').map(m=>contentText(m.content))];
    if(!systems.some(s=>s.includes('你正在进行“线下见面模式”')))return null;
    const row={kind:'offline-check',time:Date.now(),entity:'线下自动生图',mode:'线下触发检查',state:'running',offlineCheck:{requirement:systems.some(s=>s.includes('【图片生成/NovelAI Instructions】')),replyChecked:false},message:''};
    checks.add(row);while(checks.size>12)checks.delete(checks.values().next().value);
    summary(row);
    return {row,url:new URL(url,location.href).href};
  }
  function analyse(ctx,raw){
    const row=ctx.row;let text='',found=false,finishReason='',streamed='',snapshot='',parsedAny=false,pendingId='';
    function packet(data){
      if(!data||typeof data!=='object')return;
      if(typeof data.requestId==='string'&&!data.content)pendingId=data.requestId;
      const first=data.choices?.[0];
      if(first){parsedAny=true;const delta=contentText(first.delta?.content);streamed+=delta;if(first.message?.content!==undefined){snapshot=contentText(first.message.content);found=true;}if(delta)found=true;finishReason=first.finish_reason||finishReason;}
      if(data.type==='content_block_delta'&&data.delta?.type==='text_delta'){streamed+=String(data.delta.text||'');found=true;parsedAny=true;}
      if(data.type==='content_block_start'&&data.content_block?.type==='text'){streamed+=String(data.content_block.text||'');found=true;parsedAny=true;}
      if(data.type==='message_delta')finishReason=data.delta?.stop_reason||finishReason;
      if(data.type==='message'&&Array.isArray(data.content)){snapshot=contentText(data.content);found=true;parsedAny=true;finishReason=data.stop_reason||finishReason;}
      if(typeof data.content==='string'){snapshot=data.content;found=true;parsedAny=true;}
    }
    if(/^\s*\{/.test(raw)){try{packet(JSON.parse(raw));}catch{}}
    else for(const line of raw.split(/\r?\n/)){const m=line.match(/^data:\s*(.*)$/);if(!m||m[1]==='[DONE]')continue;try{packet(JSON.parse(m[1]));}catch{}}
    text=snapshot||streamed;
    if(pendingId&&!found){
      const resultUrl=new URL(ctx.url);resultUrl.pathname=resultUrl.pathname.replace(/\/api\/chat\/?$/,'/api/result/'+encodeURIComponent(pendingId));
      if(resultUrl.href!==ctx.url)backend.set(resultUrl.href,ctx);
      row.state='running';row.offlineCheck.responseNote='后台已接受聊天任务，当前响应未包含最终回复；等待同一页面读取结果。';summary(row);return;
    }
    if(!found&&!parsedAny){row.state='failed';row.offlineCheck.responseNote='当前回复结构暂无法检查；不能据此认定模型没有输出图片指令。';summary(row);return;}
    const tags=text.match(/\[图片\]\s*.*?(?=\n|$)/g)||[],scenes=tags.map(tag=>tag.slice(4).trim()).filter(Boolean);
    row.scenes=scenes.flatMap(scene=>{const out=[scene];const named=scene.match(/^[^:：\n]{1,80}[:：]\s*([\s\S]+)$/);if(named)out.push(named[1].trim());return out;}).filter(s=>s.length>=8);
    Object.assign(row.offlineCheck,{replyChecked:true,validDirectives:scenes.length,emptyDirectives:tags.length-scenes.length,alternativeFormat:/【图片】|\[(?:image|Image|IMAGE)\]|<image>|\[图片[：:]/.test(text),finishReason});
    row.state='done';associate(row);summary(row);
    for(const [url,value]of backend)if(value===ctx)backend.delete(url);
  }
  async function consume(ctx,response){
    let reader,timer;
    try{
      if(!response.ok){ctx.row.state='failed';ctx.row.offlineCheck.responseNote='聊天接口返回 HTTP '+response.status+'，尚未完成图片指令检查。';summary(ctx.row);return;}
      reader=response.clone().body?.getReader();if(!reader)throw Error('no-body');readers.add(reader);
      const decoded=new TextDecoder();let raw='',bytes=0;
      const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),180000);timers.add(timer);});
      for(;;){const {done,value}=await Promise.race([reader.read(),timeout]);if(done)break;bytes+=value.byteLength;if(bytes>4*1024*1024)throw Error('limit');raw+=decoded.decode(value,{stream:true});if(!active)throw Error('disposed');}
      raw+=decoded.decode();if(active)analyse(ctx,raw);
    }catch(error){
      if(active){ctx.row.state='failed';ctx.row.offlineCheck.responseNote=error.message==='limit'?'回复较长，检查已停止；不能据此判断图片指令是否缺失。':'本次回复未能完整检查；不能据此判断图片指令是否缺失。';summary(ctx.row);}
    }finally{if(timer){clearTimeout(timer);timers.delete(timer);}if(reader){readers.delete(reader);reader.cancel().catch(()=>{});}}
  }
  async function forward(ctx,input,init,fetchBase){
    try{let prepared;try{prepared=await prepareRequest?.(input,init);}catch{}const response=await fetchBase(prepared?.input||input,prepared?prepared.init:init);consume(ctx,response).catch(()=>{});return response;}
    catch(error){ctx.row.state='failed';ctx.row.offlineCheck.responseNote='聊天连接未完成，尚未检查到最终图片指令。';summary(ctx.row);throw error;}
  }
  return {inspect,forward,noteImage,dispose(){active=false;for(const timer of timers)clearTimeout(timer);timers.clear();for(const reader of readers)reader.cancel().catch(()=>{});readers.clear();checks.clear();backend.clear();events.length=0;}};
}

// Return embedded pixels to Roche so its existing local save / ImgBB path applies.
// No generation retries and no new image hosting service.
function createReferenceResultTransport({fetchBase,mode=()=> 'embedded',notify=()=>{}}){
  const encode=buffer=>{const a=new Uint8Array(buffer);let s='';for(let i=0;i<a.length;i+=32768)s+=String.fromCharCode(...a.subarray(i,i+32768));return btoa(s);};
  const decode=s=>new TextDecoder().decode(Uint8Array.from(atob(s),c=>c.charCodeAt(0)));
  const imageRoute=url=>{try{return /\/images\/(edits|generations)\/?$/.test(new URL(url,location.href).pathname);}catch{return false;}};
  async function prepare(input,init){
    const req=input instanceof Request?input:null;
    if(String(init?.method||req?.method||'GET').toUpperCase()!=='POST')return null;
    const url=req?.url||String(input),headers=new Headers(init?.headers||req?.headers);
    let body=init?.body,envelope=null,target=url;
    if(body===undefined&&req){const copy=req.clone();body=headers.get('content-type')?.includes('multipart/form-data')?await copy.formData():await copy.text();}
    if(typeof body==='string'){try{body=JSON.parse(body);}catch{return null;}}
    if(!imageRoute(target)){
      if(!body||typeof body.url!=='string'||!imageRoute(body.url))return null;
      envelope=body;target=body.url;
      if(body.bodyEncoding==='base64'){
        const bytes=Uint8Array.from(atob(body.body),c=>c.charCodeAt(0));
        body=new Headers(envelope.headers).get('content-type')?.includes('multipart/form-data')?await new Response(bytes,{headers:envelope.headers}).formData():JSON.parse(decode(envelope.body));
      }else body=typeof body.body==='string'?JSON.parse(body.body):body.body;
    }
    const model=String(body instanceof FormData?body.get('model'):body?.model||'');
    // Official GPT Image returns base64 natively and rejects response_format.
    const official=new URL(target,location.href).hostname==='api.openai.com';
    const change=mode()==='embedded'&&/^(gpt-image|dall-e)(?:[- .]|$)/i.test(model)&&(!official||/^dall-e/i.test(model));
    if(!change)return {input,init,url,headers,envelope};
    if(body instanceof FormData){const copy=new FormData();for(const [k,v] of body)copy.append(k,v);body=copy;body.set('response_format','b64_json');}
    else body={...body,response_format:'b64_json'};
    const packedBody=body instanceof FormData?body:JSON.stringify(body);let outgoing=packedBody;
    if(envelope){
      const packed=new Request('https://roche.local/pack',{method:'POST',body:packedBody});
      const inner=new Headers(envelope.headers);inner.delete('content-length');inner.set('content-type',body instanceof FormData?packed.headers.get('content-type'):'application/json');
      outgoing=JSON.stringify({...envelope,headers:Object.fromEntries(inner),body:encode(await packed.arrayBuffer()),bodyEncoding:'base64'});
    }else{headers.delete('content-length');headers.delete('content-type');if(!(body instanceof FormData))headers.set('content-type','application/json');}
    return {input:req?new Request(req,{...init,body:outgoing,headers}):input,init:req?undefined:{...init,body:outgoing,headers},url,headers,envelope};
  }
  function candidates(data,depth=0){
    if(!data||depth>6)return [];
    if(typeof data==='string')return /^https?:\/\//i.test(data)||/^data:image\//i.test(data)?[data]:[];
    if(Array.isArray(data))return data.flatMap(x=>candidates(x,depth+1));
    if(typeof data!=='object')return [];
    for(const k of ['b64_json','b64','base64','image_base64'])if(typeof data[k]==='string'&&data[k])return [data[k].startsWith('data:')?data[k]:'data:image/png;base64,'+data[k]];
    const nested=['data','images','output','result','results','candidates','content','parts'].flatMap(k=>candidates(data[k],depth+1));
    if(nested.length)return nested;
    for(const k of ['url','image_url','imageUrl','output_url','image'])if(data[k]){const found=candidates(data[k],depth+1);if(found.length)return found;}
    return [];
  }
  async function download(url,ctx,signal){
    const destination=new URL(url);if(!/^https?:$/.test(destination.protocol)||destination.username||destination.password)throw Error('invalid-image-url');
    const controller=new AbortController(),abort=()=>controller.abort();
    if(signal?.aborted)throw Error('aborted');signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,20000);
    try{
      let response;
      // Reuse only the proxy already configured for this request.
      if(ctx.envelope){
        const headers=new Headers(ctx.headers);headers.delete('content-length');headers.set('content-type','application/json');
        response=await fetchBase(ctx.url,{method:'POST',headers,signal:controller.signal,body:JSON.stringify({url,method:'GET',headers:{Accept:'image/*'}})});
      }else response=await fetchBase(url,{method:'GET',credentials:'omit',referrerPolicy:'no-referrer',signal:controller.signal});
      if(!response.ok||response.headers.get('x-ai-proxy-error')==='true')throw Error('download-failed');
      if(Number(response.headers.get('content-length'))>25*1024*1024)throw Error('image-too-large');
      const reader=response.body.getReader();let size=0;const parts=[];
      while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>25*1024*1024){await reader.cancel();throw Error('image-too-large');}parts.push(value);}
      const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
      const ascii=(a,b)=>String.fromCharCode(...bytes.subarray(a,b));
      const mime=bytes[0]===137&&ascii(1,4)==='PNG'?'image/png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP'?'image/webp':/^GIF8[79]a$/.test(ascii(0,6))?'image/gif':null;
      if(!mime)throw Error('not-image');
      return 'data:'+mime+';base64,'+encode(bytes);
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  return async function(input,init){
    let ctx;try{ctx=await prepare(input,init);}catch{}if(!ctx)return fetchBase(input,init);
    const response=await fetchBase(ctx.input,ctx.init);
    if(!response.ok||response.headers.get('x-ai-proxy-error')==='true')return response;
    try{
      const data=await response.clone().json(),items=candidates(data);if(!items.length)return response;
      const values=[];let remote=false;
      for(const item of items){
        if(item.startsWith('data:image/'))values.push(item);
        else try{values.push(await download(item,ctx,init?.signal||(input instanceof Request?input.signal:undefined)));}catch{remote=true;values.push(item);}
      }
      const headers=new Headers(response.headers);for(const key of ['content-length','content-encoding','etag'])headers.delete(key);
      headers.set('content-type','application/json');headers.set('x-roche-image-storage',remote?'remote':'embedded');
      if(remote)notify('接口只返回外部链接，图片未能下载保存；请及时保存原图。未重新生图。可在接口兼容设置选择「优先返回图片数据」。');
      return new Response(JSON.stringify({...data,data:values.map(x=>x.startsWith('data:')?{b64_json:x}:{url:x})}),{status:response.status,statusText:response.statusText,headers});
    }catch{return response;}
  };
}

async function referenceImageRequest(input,init){
  const req=input instanceof Request?input:null;
  if(String(init?.method||req?.method||'GET').toUpperCase()!=='POST')return false;
  const matches=url=>{try{return /\/images\/(?:edits|generations)\/?$/.test(new URL(url,location.href).pathname);}catch{return false;}};
  if(matches(req?.url||String(input)))return true;
  let body=init?.body;
  if(body===undefined&&req&&req.headers.get('content-type')?.includes('application/json'))body=await req.clone().text();
  if(typeof body!=='string'||!body.includes('/images/'))return false;
  try{const data=JSON.parse(body);return typeof data?.url==='string'&&matches(data.url);}catch{return false;}
}
function createReferenceNetwork({profiles, native, engine, field, toast, fetchBase, presetLabel,offlineCheck,protect=()=>false,resolveContext}) {
  let active = true;
  const pending = new Map();
  const encode = buffer => { const bytes = new Uint8Array(buffer); let text = ''; for (let n=0;n<bytes.length;n+=32768) text += String.fromCharCode(...bytes.subarray(n,n+32768)); return btoa(text); };
  const decode = text => Uint8Array.from(atob(text), c=>c.charCodeAt(0));
  const digest = async blob => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');
  function failure(message) { toast(message); return new Response(JSON.stringify({error:{message:'[多图参考插件] '+message}}), {status:403,headers:{'Content-Type':'application/json','x-roche-reference-error':'true'}}); }
  const protecting=()=>protect()&&Object.values(profiles()).some(p=>p.enabled);
  function blocked(message,prompt=''){
    const text=message+' 本次已在本机暂停，未提交生图接口；请在多图参考中检查对应人物的绑定和本次图片场景。';
    engine.report({time:Date.now(),entity:'参考保护',mode:'提交前检查',count:0,state:'blocked',prompt,message:text});
    return failure(text);
  }
  function hasImage(data, depth=0) {
    if (!data || depth>6) return false;
    if (typeof data==='string') return /^https?:\/\//.test(data)||/^data:image\//.test(data)||(data.length>100&&/^[A-Za-z0-9+/=\s_-]+$/.test(data));
    if (Array.isArray(data)) return data.some(x=>hasImage(x,depth+1));
    if (typeof data!=='object') return false;
    return ['b64_json','b64','base64','image_base64','image','url','image_url','imageUrl','output_url','data','images','output','result','results','candidates','content','parts','inlineData','inline_data'].some(k=>hasImage(data[k],depth+1));
  }
  async function inspect(input, init) {
    const req = input instanceof Request ? input : null;
    const method=String(init?.method||req?.method||'GET').toUpperCase(); if(method!=='POST')return null;
    const url = typeof input==='string'?input:input instanceof URL?input.href:req?.url;
    if(!url)return null;
    const headers = new Headers(init?.headers||req?.headers);
    let body=init?.body, envelope=null, target=url;
    if(!/\/images\/edits\/?(?:\?|$)/.test(new URL(target,location.href).pathname)) {
      if (typeof body!=='string') { if (!req || !headers.get('content-type')?.includes('application/json')) return null; body=await req.clone().text(); }
      if (!body.includes('images/edits')) return null;
      try{envelope=JSON.parse(body);}catch{return null;}
      if(typeof envelope.url!=='string'||!/\/images\/edits\/?$/.test(new URL(envelope.url,location.href).pathname))return null;
      target=envelope.url;
      if(envelope.bodyEncoding!=='base64'||typeof envelope.body!=='string')return null;
      body=await new Response(decode(envelope.body),{headers:envelope.headers}).formData();
    } else if (!(body instanceof FormData)) {
      const source = req && init?.body===undefined ? req.clone() : new Request(url,{...init,method,headers});
      body=await source.formData();
    }
    if (!(body instanceof FormData)) return null;
    return {body,envelope,url,target,headers,req};
  }
  async function observePlain(input,init){
    const req=input instanceof Request?input:null;
    if(String(init?.method||req?.method||'GET').toUpperCase()!=='POST')return null;
    let url=typeof input==='string'?input:input instanceof URL?input.href:req?.url;
    let body=init?.body;
    if(body===undefined&&req)body=await req.clone().text();
    if(typeof body!=='string')return null;
    if(!String(url).includes('/images/generations')&&!body.includes('/images/generations'))return null;
    let data=JSON.parse(body);
    if(typeof data?.url==='string'){
      url=data.url;
      if(!/\/images\/generations\/?$/.test(new URL(url,location.href).pathname))return null;
      data=typeof data.body==='string'?JSON.parse(data.bodyEncoding==='base64'?new TextDecoder().decode(decode(data.body)):data.body):data.body;
    }
    if(!url||!/\/images\/generations\/?$/.test(new URL(url,location.href).pathname)||typeof data?.prompt!=='string')return null;
    // Observe only: never infer a character or attach references to an unbound scene.
    return {time:Date.now(),entity:'原生生图（未确认角色）',mode:'未使用多图增强',count:0,state:'running',prompt:data.prompt,message:'检测到原生文字生图请求；这次未由插件附加参考图。请检查场景的人物描述、锁脸绑定及生成入口。'};
  }
  async function preparePlain(input,init,prompt){
    const context=resolveContext?.(prompt);
    if(!context?.profile)return {reason:context?.reason,blocked:context?.blocked,sceneOnly:context?.noIdentity};
    const req=input instanceof Request?input:null;
    const headers=new Headers(init?.headers||req?.headers);
    let url=req?.url||String(input),envelope=null;
    let data=JSON.parse(init?.body===undefined&&req?await req.clone().text():init.body);
    let target=url;
    if(typeof data.url==='string'){
      envelope=data;target=data.url;
      data=typeof data.body==='string'?JSON.parse(data.bodyEncoding==='base64'?new TextDecoder().decode(decode(data.body)):data.body):data.body;
    }
    // Only known GPT-image routes can be converted from JSON generation to image editing.
    // Do not silently rewrite third-party-specific schemas or existing image inputs.
    if(!/^gpt-image(?:[- .]|$)/i.test(String(data.model||'')))return {reason:'此模型的文字转参考图接口尚未验证',blocked:context.paired};
    if(Object.keys(data).some(k=>!['model','prompt','size','n','quality','background','output_format','output_compression','moderation','user','response_format'].includes(k)))return {reason:'本次接口包含尚未适配的参数，未转换为多图请求',blocked:context.paired};
    const destination=new URL(target,location.href);destination.pathname=destination.pathname.replace(/\/generations\/?$/,'/edits');
    target=destination.href;if(envelope)envelope={...envelope,url:target};else url=target;
    const body=new FormData();for(const [key,value] of Object.entries(data))if(value!=null)body.append(key,String(value));
    return {body,envelope,url,target,headers,req,context};
  }
  async function passThrough(input,init,record){
    if(!record)return fetchBase(input,init);
    offlineCheck?.noteImage(record.prompt,record.count?'原生单图生图请求':'原生文字生图请求');
    engine.report(record);
    try{const response=await fetchBase(input,init);const local=response.headers.get('x-roche-reference-error')==='true';record.state=local?'blocked':response.ok?'done':'failed';record.message+=local?' 本机参考保护已拦截；这不是生图站返回的错误。':' 请求链返回 HTTP '+response.status+'（需结合站点记录确认来源）。';record.message+=response.headers.get('x-roche-image-storage')==='embedded'?' 图片数据已交回 Roche，可沿用本地保存与图床上传。':response.headers.get('x-roche-image-storage')==='remote'?' 注意：外部图片下载失败，尚未保存本地图片；请及时保存原图，勿直接重新生成。':'';engine.report(record);return response;}
    catch(error){record.state='failed';record.message+=' 请求未完成。';engine.report(record);throw error;}
  }
  async function hooked(input, init) {
    if (!active) return fetchBase(input,init);
    if(offlineCheck){let check;try{check=await offlineCheck.inspect(input,init);}catch{}if(check)return offlineCheck.forward(check,input,init,fetchBase);}
    let info;
    try{info=await inspect(input,init);}catch{if(protecting()&&await referenceImageRequest(input,init))return blocked('无法读取本次图片请求的参考图。');return fetchBase(input,init);}
    if(!info){
      let record,prepared;try{record=await observePlain(input,init);if(record)prepared=await preparePlain(input,init,record.prompt);}catch{}
      if(prepared?.context)info=prepared;
      else {
        if(record&&prepared?.reason)record.message+=' '+prepared.reason+'。';
        if(prepared?.blocked||!prepared?.sceneOnly&&protecting()&&await referenceImageRequest(input,init))return blocked(prepared?.reason||'这次请求没有可确认的多图参考。',record?.prompt);
        return passThrough(input,init,record);
      }
    }
    const originals=[...info.body.getAll('image'),...info.body.getAll('image[]')].filter(x=>x instanceof Blob);
    const converted=Boolean(info.context),prompt=String(info.body.get('prompt')||'');
    const requestContext=info.context||resolveContext?.(prompt);
    if(!converted){
      if(requestContext?.paired||requestContext?.noIdentity){if(requestContext.blocked)return blocked(requestContext.reason,prompt);info.context=requestContext;}
    }
    const sceneOnly=info.context?.noIdentity===true;
    if(!converted&&!sceneOnly&&originals.length!==1)return info.context?.paired||protecting()?blocked('原生图片数量不符合当前多图接入方式。',prompt):fetchBase(input,init);
    const hash=converted||sceneOnly?'':await digest(originals[0]);
    if(info.context?.paired&&!converted&&!sceneOnly){
      const ctx=info.context;
      const anchors=[ctx.anchorProfile,profiles()[ctx.anchorProfile.pairedPersonaId]];
      if(!anchors.some(p=>{const e=native().entities().find(e=>String(e.id)===String(p?.id));return p?.enabled&&p.boundDigest===hash&&e?.faceLock?.enabled===true&&e.faceLock.libraryItemId===p.libraryId;}))return blocked('原生图片与本对话双方的参考绑定不一致，未替换图片。',prompt);
    }
    offlineCheck?.noteImage(prompt,'原生锁脸生图请求');
    const all=info.context?[info.context.profile]:Object.values(profiles()).filter(p=>p.enabled&&p.boundDigest===hash);
    if(!all.length){if(protecting())return blocked('本次锁脸图未匹配已启用的参考设置。',prompt);return passThrough(input,init,Object.values(profiles()).some(p=>p.enabled)?{time:Date.now(),entity:'原生锁脸（未匹配多图配置）',mode:'未使用多图增强',count:originals.length,state:'running',prompt,message:'原生提交的锁脸图与已启用的多图绑定不一致，本次保留原生请求。请在目标角色中套用并保存参考设置。'}:null);}
    const candidates=sceneOnly?all:all.filter(p=>{
      const person=native().entities().find(e=>String(e.id)===p.id);
      const hasTarget=prompt.includes('Apply the uploaded identity reference only to ');
      return person?.faceLock?.enabled!==false && person?.faceLock?.libraryItemId===p.libraryId && (info.context?.paired||!hasTarget||prompt.includes('Apply the uploaded identity reference only to '+(person.handle||person.name)+'.'));
    });
    if(candidates.length!==1)return blocked('无法唯一确认这次锁脸对应的角色，请检查角色名称和锁脸绑定。',prompt);
    const profile=candidates[0], person=native().entities().find(e=>String(e.id)===profile.id);
    const onlineSingle=requestContext?.channel==='online'&&String(requestContext.profile?.id)===String(profile.id);
    // A unique native anchor already identifies the character, even if a pending
    // row has not become visible yet. Keep that identity; never infer user from it.
    const nativeAnchorFallback=!sceneOnly&&profile.pairedPersonaId&&!info.context?.paired&&!onlineSingle;

    if(nativeAnchorFallback){
      const pairedUser=native().entities().find(e=>String(e.id)===String(profile.pairedPersonaId));
      const names=[pairedUser?.name,pairedUser?.handle,...String(profiles()[profile.pairedPersonaId]?.subjectAliases||'').split(/[,，\n]/),'user','用户'].filter(Boolean);
      if(typeof referenceNameMentions==='function'&&referenceNameMentions(prompt,names).length)return blocked('场景含 user，但缺少本次会话来源，未将角色参考套给 user。',prompt);
    }
    // Remove only the exact wrapper generated by this supported Roche build.
    // The user's scene, positive/negative prompts and character instructions remain intact.
    const nativePrefixFor=p=>['Use the uploaded image as the primary identity and face reference.',
      'Apply the uploaded identity reference only to '+(p.handle||p.name)+'.',
      'Preserve the same person: facial structure, eye shape, nose, lips, jawline, skin tone, hair identity cues, and distinctive marks.',
      'If the image contains multiple people, keep all other people visually distinct and do not copy the reference face onto them.',
      'Follow the written prompt for pose, clothing, scene, lighting, and style, but do not replace the person with a different face.'].join(' ');
    const prefixPeople=info.context?.paired?native().entities().filter(e=>[String(info.context.anchorPerson.id),info.context.anchorProfile.pairedPersonaId].includes(String(e.id))):[person];
    const nativePrefix=prefixPeople.map(nativePrefixFor).find(p=>prompt.startsWith(p+'\n\n'));
    const scenePrompt=referenceSceneCast(nativePrefix?prompt.slice(nativePrefix.length+2):prompt).scene;
    const subjects=info.context?.subjects||[{profile,person}];
    const separate=info.context?.paired&&(subjects.length===2||info.context.otherPeople||String(person.id)!==String(info.context.anchorPerson.id));
    let plan;
    try{plan=sceneOnly?{references:[],prompt:[profile.stylePrompt,info.context.scene].filter(Boolean).join('\n\n')}:separate?engine.planSubjects(info.context.scene,subjects):engine.plan(scenePrompt,{},'',{rocheReferenceProfile:{...profile,identityMode:'always'},faceLockTargetName:person.handle||person.name});}
    catch{return blocked('人物参考设置无法读取，请重新保存双方的参考设置。',prompt);}
    if(!plan.references.length&&!sceneOnly)return failure('此角色的参考图为空，已停止生成。');
    let sceneData;
    if(sceneOnly){
      const allowed=['model','prompt','size','n','quality','background','output_format','output_compression','moderation','user','response_format'];
      if([...info.body.keys()].some(k=>!allowed.includes(k)&&!['image','image[]','input_fidelity'].includes(k)))return blocked('无人参考场景包含尚未适配的图片编辑参数，未更改请求。',prompt);
      sceneData={};for(const k of allowed)if(info.body.has(k))sceneData[k]=['n','output_compression'].includes(k)?Number(info.body.get(k)):String(info.body.get(k));sceneData.prompt=plan.prompt;
      const destination=new URL(info.target);destination.pathname=destination.pathname.replace(/\/edits\/?$/,'/generations');info.target=destination.href;
      if(info.envelope)info.envelope={...info.envelope,url:info.target};else info.url=info.target;
    }
    // Include credentials only in this short-lived in-memory key; never put them in logs or storage.
    const signature=JSON.stringify([info.target,prompt,subjects.map(s=>[s.profile.id,s.profile.updatedAt]),info.context?.anchorProfile?.updatedAt,plan.prompt,field(),info.envelope?.headers||[...info.headers],[...info.body].filter(([key])=>!['image','image[]','prompt'].includes(key))]);
    if(pending.has(signature)) return (await pending.get(signature)).clone();
    const primaryCount=plan.references.filter(r=>r.role==='identity'&&r.primary).length;
    const record={time:Date.now(),entity:sceneOnly?'当前场景':subjects.map(s=>s.person.name||s.person.handle).join(' + '),count:plan.references.length,mode:sceneOnly?'无人物参考':info.context?.paired?(subjects.length===2?'双人分别参考':info.context.otherPeople?'其他人物同场，仅附已绑定人物参考':String(person.id)!==String(info.context.anchorPerson.id)?'user 单人参考':'角色单人参考'):`锁脸多图（主参考 ${primaryCount} 张）`,source:info.context?.source||(nativeAnchorFallback?'原生锁脸图片及角色绑定；来源未确认，只使用原生绑定角色，未追加 user':'原生锁脸图片及角色绑定'),state:'running',message:(info.context?.decision?info.context.decision+'。':'')+'已准备本次图片请求……',presetLabel:subjects.map(s=>(s.person.name||s.person.handle)+'：'+(presetLabel?.(s.profile)||'自定义参考设置')).join('；'),references:plan.references.map(ref=>({...ref})),prompt:plan.prompt}; engine.report(record);
    const task=(async()=>{
      try{
        const body=new FormData();for(const [key,value] of info.body) if(!['image','image[]','prompt'].includes(key)) body.append(key,value);
        body.append('prompt',plan.prompt);
        for(let i=0;i<plan.references.length;i++){
          const ref=plan.references[i],m=ref.image.match(/^data:(image\/[\w+.-]+);base64,(.*)$/s);
          if(!m)throw Error('invalid-ref');
          body.append(field()==='image[]'?'image[]':'image',new Blob([decode(m[2])],{type:m[1]}),`reference-${i+1}-${ref.role}.${m[1]==='image/jpeg'?'jpg':m[1]==='image/webp'?'webp':'png'}`);
        }
        let requestBody=sceneOnly?JSON.stringify(sceneData):body,headers=info.headers;
        if(info.envelope){
          const packed=new Request('https://roche.local/form-data',{method:'POST',body:requestBody});
          const proxyHeaders=new Headers(info.envelope.headers);proxyHeaders.set('content-type',sceneOnly?'application/json':packed.headers.get('content-type'));
          requestBody=JSON.stringify({...info.envelope,headers:Object.fromEntries(proxyHeaders),body:encode(await packed.arrayBuffer()),bodyEncoding:'base64'});
        }else{headers.delete('content-type');headers.delete('content-length');if(sceneOnly)headers.set('content-type','application/json');}
        if(!active)return failure('参考插件已停用，本次尚未发送的请求已取消。');
        const signal=init?.signal||info.req?.signal;if(signal?.aborted)throw new DOMException('Aborted','AbortError');
        const base=info.req?new Request(info.url,new Request(info.req,{...init,body:requestBody,headers})):info.url;
        const response=await fetchBase(base,info.req?undefined:{...init,body:requestBody,headers});
        if(!response.ok||response.headers.get('x-ai-proxy-error')==='true')throw Error('HTTP '+response.status);
        let data;try{data=await response.clone().json();}catch{throw Error('invalid-result');}
        if(!hasImage(data))throw Error('no-image');
        record.state='done';record.message=(info.context?.decision?info.context.decision+'。':'')+`已提交 ${plan.references.length} 张参考图，接口已返回图片。`;record.message+=response.headers.get('x-roche-image-storage')==='embedded'?' 图片数据已交回 Roche，可沿用本地保存与图床上传。':response.headers.get('x-roche-image-storage')==='remote'?' 注意：外部图片下载失败，尚未保存本地图片；请及时保存原图，勿直接重新生成。':'';engine.report(record);return response;
      }catch(error){
        const status=/^HTTP \d+$/.test(error.message)?error.message:'连接中断或未返回可识别图片';
        record.state='failed';record.message=(info.context?.decision?info.context.decision+'。':'')+`${sceneOnly?'场景':'多图'}生成失败（${status}）。未自动重发；请查看 API 站记录后决定是否重试。`;engine.report(record);
        // Roche's current implementation retries most statuses without images. 403 stops that fallback locally.
        return failure(record.message);
      }
    })();pending.set(signature,task);
    try{return(await task).clone();}finally{pending.delete(signature);}
  }
  return {fetch:hooked,digest,dispose(){active=false;pending.clear();offlineCheck?.dispose();}};
}

// Resolve program chunks referenced by this same-origin page, without pinning a build hash.
async function discoverRocheCores({entries,document,href,fetch}) {
  const page=new URL(href),cores=new Set(),sources=new Set();
  function asset(value,base=href){
    try{const url=new URL(value,base);return url.origin===page.origin&&/^\/assets\/[\w.-]+\.js$/.test(url.pathname)?url.href:null;}catch{return null;}
  }
  function add(value,base){
    const url=asset(value,base);if(!url)return;
    if(/\/ai-core-[\w-]+\.js$/.test(new URL(url).pathname))cores.add(url);
    else if(/\/(?:index|App|access-bootstrap|verifiedRuntime|ContactEdit|PersonaEdit|PersonaArchive|ChatSettings|ChatSettingsIdentity|GalleryApp|PluginHost)-[\w-]+\.js$/.test(new URL(url).pathname))sources.add(url);
  }
  for(const entry of entries)add(entry.name);
  for(const node of document.querySelectorAll('script[type="module"][src],link[rel="modulepreload"][href]'))add(node.src||node.href);
  if(cores.size)return [...cores].reverse();
  // Safari may evict early resources from its timing buffer. Read only known page
  // entry chunks, then follow their explicit same-origin JavaScript references.
  const seen=new Set();
  while(sources.size&&seen.size<16&&!cores.size){
    const url=[...sources].find(u=>!seen.has(u));if(!url)break;seen.add(url);
    try{
      const response=await fetch(url,{cache:'force-cache',credentials:'same-origin'});
      if(!response.ok)continue;
      const text=await response.text();if(text.length>6000000||/^\s*</.test(text))continue;
      for(const match of text.matchAll(/["'`]((?:\.\.?\/|\/?assets\/)[^"'`\s<>]+\.js)["'`]/g))add(match[1],url);
    }catch{}
  }
  return [...cores].reverse();
}

function createRocheReferencePresets({cleanProfile,persist,initial=[],newId=()=>crypto.randomUUID()}) {
  const banks=new Map(),queues=new Map(),maxPresets=20;
  const clone=value=>JSON.parse(JSON.stringify(value));
  const title=value=>String(value||'').trim().slice(0,80);
  const sameName=(a,b)=>title(a).normalize('NFKC').toLowerCase()===title(b).normalize('NFKC').toLowerCase();
  function cleanItems(items){
    if(!Array.isArray(items)||items.length>maxPresets)throw Error('每个角色最多保存 20 个参考预设。');
    const ids=new Set(),names=[];
    return items.map(item=>{
      if(!item||typeof item.id!=='string'||!item.id||item.id.length>128||ids.has(item.id))throw Error('预设编号无效或重复。');
      const name=title(item.name);if(!name||names.some(n=>sameName(n,name)))throw Error('预设名称为空或重复。');
      const profile=cleanProfile(item.profile);if(!profile.identityImages.length)throw Error('参考预设至少需要一张人物图。');
      ids.add(item.id);names.push(name);return{id:item.id,name,profile,updatedAt:Number(item.updatedAt)||Date.now()};
    });
  }
  for(const [owner,items]of initial)banks.set(String(owner),cleanItems(items));
  const list=owner=>clone(banks.get(String(owner))||[]);
  function change(owner,fn){
    owner=String(owner);const task=(queues.get(owner)||Promise.resolve()).catch(()=>{}).then(async()=>{
      const result=fn(list(owner)),checked=cleanItems(result.items);
      await persist(owner,checked);banks.set(owner,checked);return clone(result.value);
    });queues.set(owner,task);return task.finally(()=>{if(queues.get(owner)===task)queues.delete(owner);});
  }
  async function put(owner,{id,name,profile}){
    name=title(name);if(!name)throw Error('请给预设起一个名称。');
    const checked=cleanProfile(profile);if(!checked.identityImages.length)throw Error('请先添加人物参考图，再保存预设。');
    return change(owner,items=>{
      const at=id?items.findIndex(p=>p.id===id):-1;if(id&&at<0)throw Error('这个预设已不存在，请重新选择。');
      if(items.some(p=>p.id!==id&&sameName(p.name,name)))throw Error('已有同名预设，请选择它并点「更新所选预设」，或换一个名称。');
      const item={id:id||newId(),name,profile:checked,updatedAt:Date.now()};if(at<0)items.push(item);else items[at]=item;
      return {items,value:item};
    });
  }
  const remove=(owner,id)=>change(owner,items=>{if(!items.some(p=>p.id===id))throw Error('这个预设已不存在。');return{items:items.filter(p=>p.id!==id),value:true};});
  function prepareImport(groups,allowed){
    if(groups===undefined)return [];
    if(!Array.isArray(groups)||groups.length>500)throw Error('参考预设备份格式不正确。');
    const seen=new Set();return groups.map(group=>{
      if(typeof group?.ownerId!=='string'||!group.ownerId||group.ownerId.length>240||seen.has(group.ownerId))throw Error('预设所属角色编号无效或重复。');
      seen.add(group.ownerId);return {ownerId:group.ownerId,presets:cleanItems(group.presets)};
    }).filter(group=>allowed.has(group.ownerId));
  }
  async function importPrepared(groups){
    let saved=0;for(const group of groups){await change(group.ownerId,()=>({items:group.presets,value:true}));saved+=group.presets.length;}return saved;
  }
  return {list,put,remove,maxPresets,prepareImport,importPrepared,exportLibraries:()=>[...banks].map(([ownerId,presets])=>({ownerId,presets:clone(presets)}))};
}

// Match the actual pending native image record, never the currently open chat.
function referenceNames(person,profiles){
  return [...new Set([person?.name,person?.handle,...String(profiles[String(person?.id)]?.subjectAliases||'').split(/[,，\n]/)].map(s=>String(s||'').normalize('NFKC').trim()).filter(Boolean))];
}
function referenceNameMentions(scene,names){
  const matches=[];
  for(const name of names){
    const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    for(const match of scene.matchAll(new RegExp('(^|[^a-z0-9])('+escaped+')(?=$|[^a-z0-9])','gi'))){
      const start=match.index+match[1].length;matches.push({name,start,end:start+match[2].length});
    }
  }
  return matches;
}
function referenceForeignMentions(scene,owners,others,profiles,extra=[]){
  const owned=referenceNameMentions(scene,[...owners.flatMap(p=>referenceNames(p,profiles)),...extra]);
  const found=[];
  for(const person of others){
    const mentions=referenceNameMentions(scene,referenceNames(person,profiles).filter(n=>n.length>=2));
    for(const mention of mentions){
      // A duplicate contact with the same name is not an additional subject.
      // Longer distinct names (Simon Price vs Simon) still remain a conflict.
      if(!owned.some(o=>o.start<=mention.start&&o.end>=mention.end))found.push({person,...mention});
    }
  }
  return found;
}
function referencePersonaForChat(store,chat){
  const users=store.personas||[];
  const local=String(chat?.localSettings?.myActivePersonaId||chat?.myActivePersonaId||'');
  // Mirror Roche's conversation override, then global persona fallback.
  return users.find(p=>String(p.id)===local)||users.find(p=>String(p.id)===String(store.activePersonaId))||users[0]||null;
}
function referencePairForChat(store,chat,profiles){
  const contact=chat&&(store.contacts||[]).find(p=>String(p.id)===String(chat.contactId||chat.id));
  if(!contact)return null;
  const stored=profiles[String(contact.id)]||{},source=stored.userSource|| (stored.pairedPersonaId?'fixed':'auto');
  const persona=source==='fixed'?(store.personas||[]).find(p=>String(p.id)===String(stored.pairedPersonaId)):source==='auto'?referencePersonaForChat(store,chat):null;
  const hasUser=persona&&profiles[String(persona.id)]?.enabled;
  if(source==='off'||source==='auto'&&!hasUser||source==='fixed'&&!stored.pairedPersonaId)return null;
  return {character:contact,base:{...stored,id:String(contact.id),pairedPersonaId:String(persona?.id||stored.pairedPersonaId||''),userSource:source},automatic:source==='auto'};
}
function resolveReferenceContext(store, finalPrompt, profiles) {
  const text=String(finalPrompt||'').trim(), hits=[];
  const entities=[...(store.contacts||[]),...(store.personas||[])];
  const matches=scene=>scene.length>=4&&(text===scene||text.endsWith(', '+scene)||text.endsWith('\n\n'+scene)||text.includes(', '+scene+', Avoid: '));
  const named=(scene,name)=>{
    name=String(name||'').trim();if(name.length<2)return false;
    const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return new RegExp('(^|[^a-z0-9])'+escaped+'(?=$|[^a-z0-9])','i').test(scene);
  };
  function add(row,id,source,chatId){
    const scene=String(row.prompt||'').trim();if(!matches(scene))return;
    const sourceChat=String(row.chatId||row.conversationId||chatId||'');
    if(scene.length<12){const chat=(store.conversations||[]).find(c=>String(c.id)===sourceChat.replace(/^offline_/,''));if(!referencePairForChat(store,chat,profiles))return;}
    // Failed/old records must not claim a new unrelated request.
    const stamp=Number(row.timestamp);if(!stamp||Date.now()-stamp>10*60*1000||stamp>Date.now()+60000)return;
    hits.push({row,id:String(id||''),scene,source,chatId:sourceChat,channel:source==='线下待生成图片'||sourceChat.startsWith('offline_')?'offline':'online'});
  }
  for(const [chatId,rows] of Object.entries(store.offlineGallery||{}))if(Array.isArray(rows))for(const row of rows)
    if(row.status==='pending')add(row,row.faceLockEntityId,'线下待生成图片',chatId);
  for(const [chatId,rows] of Object.entries(store.messages||{}))if(Array.isArray(rows))for(const row of rows)
    if(row.isGenerating===true&&row.type==='image')add(row,row.faceLockEntityId||row.senderId,'聊天待生成图片',chatId);
  if(!hits.length)return {reason:'未找到与本次提示词对应的待生成图片记录'};
  const pair=resolvePairedReference(store,hits,profiles);
  if(pair)return pair;
  // Even an unconfigured/unknown duplicate is a conflict. Do not take first/last.
  if(hits.some(h=>!h.id)||new Set(hits.map(h=>h.id)).size!==1)return {reason:'相同场景对应多个或未指定角色，无法唯一确认'};
  const hit=hits[0],person=entities.find(e=>String(e.id)===hit.id),profile=profiles[hit.id];
  if(!person||!profile?.enabled)return {reason:'该次图片对应角色尚未启用多图参考'};
  const otherPeople=referenceForeignMentions(hit.scene.normalize('NFKC'),[person],entities.filter(e=>String(e.id)!==hit.id),profiles).length>0;
  // Native per-character prefixes can contain a name even for landscape shots.
  // Check the original scene, never the final composed prompt, for a person.
  const hasPerson=/\b(man|woman|male|female|person|portrait|selfie|boy|girl|1man|1woman|1boy|1girl)\b|男人|女人|男子|女子|人像|自拍|肖像/i.test(hit.scene)||referenceNames(person,profiles).some(name=>named(hit.scene,name));
  const excludesPerson=/\b(no people|no person|no humans|without people|empty scene|landscape only)\b|无人|没有人物|纯风景/i.test(hit.scene);
  if(!hasPerson||excludesPerson)return {profile,person,source:hit.source,scene:referenceSceneCast(hit.scene).scene,channel:hit.channel,noIdentity:true,subjects:[],decision:'本次为物品、风景或未确认人物的场景，不附人物参考'};
  if(person.faceLock?.enabled!==true||person.faceLock.libraryItemId!==profile.libraryId)return {reason:'该角色的原生锁脸绑定已改变，请重新保存参考设置'};
  return {profile,person,source:hit.source,scene:hit.scene,channel:hit.channel,otherPeople};
}

// Counts declare how many subjects are in the scene, not which gender belongs to
// which identity. The identities still come from the verified conversation pair.
function referenceScenePeopleCount(scene){
  let typed=0,sawTyped=false;const totals=[];
  const words={one:1,two:2,three:3,four:4,five:5,six:6};
  const pattern=/(?:^|[\s,;，、])([0-9]+|one|two|three|four|five|six)\s*(boys?|girls?|men|women|man|woman|people|persons?|males?|females?)(?=$|[\s,;，、.:])/gi;
  for(const m of String(scene).matchAll(pattern)){
    const n=words[m[1].toLowerCase()]??Number(m[1]);
    if(/^(people|persons?)$/i.test(m[2]))totals.push(n);else{typed+=n;sawTyped=true;}
  }
  const distinct=[...new Set(totals)];
  if(distinct.length>1||distinct.length&&typed>distinct[0])return {conflict:true};
  return {count:distinct.length?distinct[0]:sawTyped?typed:null,conflict:false};
}

function resolvePairedReference(store,hits,profiles){
  if(hits.every(h=>h.channel==='online'))return null;
  const chats=hits.map(h=>(store.conversations||[]).find(c=>String(c.id)===h.chatId.replace(/^offline_/,'')));
  if(!chats.some(c=>referencePairForChat(store,c,profiles)))return null;
  const stop=reason=>({paired:true,blocked:true,reason});
  if(hits.some(h=>h.channel!=='offline'))return stop('线上和线下有相同的待生成场景，无法确认本次来源');
  if(chats.some(c=>!c)||new Set(chats.map(c=>String(c.id))).size!==1||new Set(hits.map(h=>h.scene)).size!==1)return stop('请求对应多个对话或场景，无法确认参考所属');
  const chat=chats[0],pair=referencePairForChat(store,chat,profiles);
  if(!pair)return stop('本次会话未找到可用的人设参考');
  const {character,base,automatic}=pair;
  if(chat.type==='group'||chat.isGroup)return stop('参考绑定目前仅支持一对一对话；剧情里可以有其他人物');
  if(!automatic&&!base?.enabled)return stop('此对话的角色参考尚未启用');
  const user=(store.personas||[]).find(p=>String(p.id)===base.pairedPersonaId);
  if(hits.some(h=>h.id&&![String(character.id),String(base.pairedPersonaId)].includes(h.id)))return stop('原生记录指定了其他档案，无法确认参考所属');
  const parsed=referenceSceneCast(hits[0].scene),scene=parsed.scene;
  const names=p=>referenceNames(p,profiles);
  const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  let people=[],otherPeople=false,decision='';
  if(parsed.cast){
    if(parsed.cast.includes('char'))people.push(character);
    if(parsed.cast.includes('user')){if(!user)return stop('画面包含 user，但绑定的身份已不存在');people.push(user);}
    otherPeople=parsed.cast.includes('other');
    decision='本轮模型自动标记：'+parsed.cast.join(' + ');
  }else{
    let visible=scene.normalize('NFKC');
    const excluded=new Set();
    for(const person of [character,user].filter(Boolean))for(const name of names(person)){
      const n=escape(name);
      visible=visible.replace(new RegExp('(?:taken|shot|photographed) by '+n+'(?=$|[^a-z0-9])','gi'),' ')
        .replace(new RegExp(n+"(?:'s)? (?:POV|point of view|behind the camera)",'gi'),' ')
        .replace(new RegExp('(?:由|让)'+n+'(?:拍摄|拍照)','gi'),' ');
      visible=visible.replace(new RegExp('(?:without|except|not including) '+n+'(?=$|[^a-z0-9])|'+n+' (?:is not visible|is absent|off.screen)|(?:没有|不含|不包括)'+n,'gi'),()=>{excluded.add(String(person.id));return ' ';});
      visible=visible.replace(new RegExp(n+"['’]s (?:hoodie|shirt|jacket|room|bedroom|car|house|phone|camera)\\b",'gi'),' ');
    }
    const hasName=(p,extra)=>!excluded.has(String(p?.id))&&referenceNameMentions(visible,[...names(p),...extra]).length>0;
    let charVisible=hasName(character,['char','main character','主角色']),userVisible=hasName(user,['user','用户']);
    if(user&&names(character).some(n=>names(user).some(u=>u.toLowerCase()===n.toLowerCase()))&&charVisible&&userVisible)return stop('双方有相同的人物称呼，且本轮未提供画面标记，无法区分两组参考');
    const others=[...(store.contacts||[]),...(store.personas||[])].filter(p=>![String(character.id),String(base.pairedPersonaId)].includes(String(p.id)));
    const foreign=referenceForeignMentions(visible,[character,user].filter(Boolean),others,profiles,['char','main character','user','用户']);
    if(foreign.length){const chars=visible.split('');for(const m of foreign)for(let i=m.start;i<m.end;i++)chars[i]=' ';visible=chars.join('');charVisible=hasName(character,['char','main character','主角色']);userVisible=hasName(user,['user','用户']);}
    const counted=referenceScenePeopleCount(visible);
    const empty=/\b(no people|no person|no humans|without people|empty scene|landscape only)\b|无人|没有人物|纯风景/i.test(visible)||counted.count===0;
    if(!empty){
      if(charVisible)people.push(character);
      if(userVisible){if(!user)return stop('画面包含 user，但绑定的身份已不存在');people.push(user);}
      const human=counted.count>0||/\b(man|woman|men|women|male|female|person|people|portrait|selfie|boy|girl|soldier|soldiers|colleague|colleagues|couple|he|she|his|her|solo)\b|男人|女人|男子|女子|人像|自拍|士兵|同事|他|她|单人|两人|双人/i.test(visible);
      if(!people.length&&!foreign.length&&human&&!excluded.has(String(character.id))){
        const useUser=base.offlineUnnamedSolo==='user'&&(counted.count===1||/\b(solo|alone|single person)\b|单人|独照/i.test(visible));
        if(useUser){if(!user)return stop('默认单人人物为 user，但绑定身份已不存在');people=[user];}
        else people=[character];
        decision=useUser?'未标记，沿用已保存的 user 单人默认':'未标记，按本对话主角色辅助；未自动添加 user';
      }
    }
    otherPeople=foreign.length>0||counted.count>people.length&&counted.count>1||/\b(crowd|group photo|colleagues|soldiers)\b|多人|其他人|同事/i.test(visible);
    if(!decision)decision=empty?'无人场景，不附人物参考':people.length?'按本轮场景中的人物称呼':'仅其他人物或未确认主体，不附人物参考';
  }
  const subjects=[];
  if(people.some(p=>String(p.id)===String(base.pairedPersonaId))){
    const activePersona=chat.localSettings?.myActivePersonaId||chat.myActivePersonaId;
    if(!automatic&&activePersona&&String(activePersona)!==String(base.pairedPersonaId))return stop('当前对话使用的 user 身份与参考绑定不同，请重新选择');
  }
  for(const person of people){
    const profile=profiles[String(person.id)];
    if(automatic&&!profile?.enabled)continue; // Auxiliary references never invent a missing profile.
    if(!profile?.enabled||!profile.identityImages?.length)return stop((person.name||person.handle)+' 尚未保存并启用人物参考图');
    if(person.faceLock?.enabled!==true||person.faceLock.libraryItemId!==profile.libraryId)return stop((person.name||person.handle)+' 的锁脸绑定已改变，请重新保存');
    subjects.push({person,profile,sceneRole:String(person.id)===String(character.id)?'char':'user'});
  }
  const kind=!subjects.length?'无人物参考':subjects.length===2?'双方分别参考':String(subjects[0].person.id)===String(base.pairedPersonaId)?'user 单人参考':'角色单人参考';
  return {paired:true,profile:subjects[0]?.profile||base,person:subjects[0]?.person||character,subjects,anchorProfile:base,anchorPerson:character,scene,otherPeople,noIdentity:!subjects.length,decision,source:hits[0].source+' · '+kind+(otherPeople?' · 有其他出镜人物':'')+' · '+decision};
}

// Local summaries only: never persist image bytes, headers, API keys or request URLs.
function referenceHistorySnapshot(rows,now=Date.now()) {
  return rows.filter(r=>Number.isFinite(r.time)&&now-r.time<7*86400000).slice(0,12).map(r=>{
    const result={};
    for(const key of ['time','entity','mode','count','state','message','presetLabel','kind','source'])
      if(typeof r[key]==='string')result[key]=r[key].slice(0,2000);else if(typeof r[key]==='number')result[key]=r[key];
    return result;
  });
}

/* Embedded enhancement for the account-login Roche builds checked on 2026-10-18. */
(() => {
  'use strict';
  if (!window.RochePlugin?.register) throw Error('请在 Roche 插件管理中安装。');
  window.__rocheReferencePlugin?.dispose();
  const ID='roche-reference-plus', VERSION='0.6.0';
  let disposed=false, db, runtime, loading, ui, engine, presets, hook, observer, frame=0, api, field='image', resultMode='embedded', noticeTimer;
  const presetRows=new Map();
  const records=new Map(), inserted=new Set(), mounts=new Map();
  const coordinator=rocheFetchCoordinator();
  let previousFetch,protection=true;
  const startupRecords=[];
  let hostState,lifecycleTimer,seenInstalled=false,historyRows=[],historyWrite=Promise.resolve();
  function checkLifecycle(){
    if(!hostState||disposed)return;
    const entry=hostState.installed.find(p=>p.id===ID||p.registeredId===ID);
    if(entry)seenInstalled=true;
    if(seenInstalled&&(!entry||entry.enabled===false))dispose();
  }
  // Register synchronously, before discovery/import/IndexedDB can yield to another plugin.
  const releaseFetch=coordinator.register(ID,next=>{
    previousFetch=next;
    return async function(input,init){
      checkLifecycle();
      if(disposed)return next.call(this,input,init);
      if(!hook&&await referenceImageRequest(input,init)){
        const signal=init?.signal||(input instanceof Request?input.signal:null);
        let timer,onAbort;
        try{
          await Promise.race([initialize(),new Promise((_,reject)=>{
            timer=setTimeout(()=>reject(Error('startup timeout')),8000);
            onAbort=()=>reject(new DOMException('Aborted','AbortError'));
            if(signal?.aborted)onAbort();else signal?.addEventListener('abort',onAbort,{once:true});
          })]);
          if(signal?.aborted)throw new DOMException('Aborted','AbortError');
          if(disposed)return next.call(this,input,init);
          if(!hook)throw Error('not ready');
        }catch(error){
          if(signal?.aborted)throw error;
          const message='参考插件尚未就绪，本次未提交生图接口。请先打开多图参考确认连接状态，再手动重试。';
          const row={time:Date.now(),entity:'参考保护',mode:'启动检查',count:0,state:'blocked',message};
          if(engine)engine.report(row);else{startupRecords.push(row);if(startupRecords.length>20)startupRecords.shift();}
          toast(message);
          return new Response(JSON.stringify({error:{message}}),{status:403,headers:{'Content-Type':'application/json','x-roche-reference-error':'true'}});
        }finally{clearTimeout(timer);if(onAbort)signal?.removeEventListener('abort',onAbort);}
      }
      return hook?hook.fetch(input,init):next.call(this,input,init);
    };
  });
  function toast(message){
    if(api?.ui?.toast)api.ui.toast(message);
    else if(runtime?.store?.capsuleToast){Object.assign(runtime.store.capsuleToast,{show:true,message:String(message),icon:'image',iconColor:'text-amber-400'});clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>{runtime.store.capsuleToast.show=false;},8000);}
  }
  function storage(action,key,value){return new Promise((resolve,reject)=>{
    const tx=db.transaction('settings',action==='getAll'?'readonly':'readwrite'), store=tx.objectStore('settings');
    const req=action==='getAll'?store.getAll():store.put({id:key,value});
    let result;req.onsuccess=()=>{result=req.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(Error('浏览器储存失败'));tx.onabort=()=>reject(Error('浏览器储存操作中止'));
  });}
  async function openDatabase(){
    db=await new Promise((resolve,reject)=>{const req=indexedDB.open('roche-reference-plus-v1',1);req.onupgradeneeded=()=>req.result.createObjectStore('settings',{keyPath:'id'});req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(Error('无法打开参考图储存'));});
    for(const row of await storage('getAll')){if(row.id==='history'&&Array.isArray(row.value))historyRows=referenceHistorySnapshot(row.value);else if(row.id==='protection')protection=row.value!==false;else if(row.id==='resultMode')resultMode=row.value==='native'?'native':'embedded';else if(row.id==='field')field=row.value==='image[]'?'image[]':'image';else if(row.id.startsWith('profile:'))records.set(row.id.slice(8),row.value);else if(row.id.startsWith('presets:'))presetRows.set(row.id.slice(8),row.value);}
  }
  const entities=()=>runtime?[...runtime.store.contacts.map(e=>({...e,_rrKind:'contact'})),...runtime.store.personas.map(e=>({...e,_rrKind:'persona'}))]:[];
  const blob=data=>{const [head,value]=data.split(',');return new Blob([Uint8Array.from(atob(value),c=>c.charCodeAt(0))],{type:head.slice(5).split(';')[0]});};
  async function save(entity,profile){
    if(profile.enabled&&!profile.identityImages.length)throw Error('请至少添加 1 张人物参考图。');
    if(profile.pairedPersonaId&&(entity._rrKind!=='contact'||!runtime.store.personas.some(p=>String(p.id)===profile.pairedPersonaId)))throw Error('请选择此角色对话中存在的 user 身份。');
    const old=records.get(String(entity.id)), current=entities().find(e=>e.id===entity.id);
    if(!current)throw Error('找不到这个角色，请刷新设置。');
    const previousLock=old?.libraryId && old.libraryId===current.faceLock?.libraryItemId ? old.previousLock : JSON.parse(JSON.stringify(current.faceLock||{enabled:false,libraryItemId:''}));
    let next={...profile,id:String(entity.id),updatedAt:Date.now(),previousLock};
    let bound=false;
    try{
      if(profile.enabled){
        const anchor=profile.identityImages[profile.primaryIndices[0] ?? 0];
        const boundDigest=await hook.digest(blob(anchor));
        const item=await runtime.addFaceLockLibraryItem({image:anchor,fingerprint:`${ID}:${entity.id}:${boundDigest}`,sourceSenderId:entity.id,sourceSenderName:entity.handle||entity.name,prompt:'多图参考插件 · 主图'});
        next={...next,libraryId:item.id,boundDigest};
        await runtime.setEntityFaceLock(entity.id,{enabled:true,libraryItemId:item.id,weight:current.faceLock?.weight||.7});bound=true;
      }else if(old?.libraryId&&old.libraryId===current.faceLock?.libraryItemId){
        await runtime.setEntityFaceLock(entity.id,old.previousLock||{enabled:false,libraryItemId:''});bound=true;
      }
      await storage('put','profile:'+entity.id,next);records.set(String(entity.id),next);
    }catch(error){
      if(bound)try{await runtime.setEntityFaceLock(entity.id,current.faceLock||{enabled:false,libraryItemId:''});}catch{throw Error('保存失败且旧锁脸选择未能恢复，请在原锁脸管理里重新确认选择。');}
      throw Error('保存未完成，请检查浏览器储存空间后重试。');
    }
  }
  async function initialize(){
    if(loading)return loading;
    loading=(async()=>{
      const urls=await discoverRocheCores({entries:performance.getEntriesByType('resource'),document,href:location.href,fetch:previousFetch});
      if(disposed)return;
      if(!urls.length)throw Error('尚未找到已加载的 Roche 角色程序。请先进入联系人页面后重试；现有参考图仍保留，无需清理网站数据。');
      for(const url of urls){
        try{const module=await import(url);if(disposed)return;
          const candidate=Object.values(module).find(v=>v?.store&&typeof v.setEntityFaceLock==='function'&&typeof v.addFaceLockLibraryItem==='function');
          if(candidate&&Array.isArray(candidate.store.contacts)&&Array.isArray(candidate.store.personas)&&Array.isArray(candidate.store.faceLockLibrary)){
            runtime=candidate;
            hostState=Object.values(module).find(v=>v&&Array.isArray(v.installed)&&Array.isArray(v.apps)&&typeof v.ready==='boolean');
            if(hostState){checkLifecycle();if(disposed)return;lifecycleTimer=setInterval(checkLifecycle,1000);}
            break;
          }
        }catch{}
      }
      if(!runtime)throw Error('当前 Roche 的角色接口发生变化，暂未连接多图增强。现有参考图仍保留，请等待适配。');
      await openDatabase();if(disposed){db?.close();return;}
      engine=createRocheReferenceEngine({entities:()=>entities().map(e=>({...e,...(records.has(String(e.id))?{rocheImageReferencesV1:records.get(String(e.id))}:{})})),save,identityAllowed:()=>true,notify:toast,
        initialHistory:historyRows.map(r=>r.state==='running'?{...r,state:'unknown',message:r.message+' 页面曾关闭或刷新，最终结果未确认，请查看站点记录。'}:r),
        persistHistory:rows=>{if(disposed)return;const snapshot=referenceHistorySnapshot(rows);historyWrite=historyWrite.then(()=>storage('put','history',snapshot)).catch(()=>{});},
        exportPresetLibraries:()=>presets.exportLibraries(),preparePresetImport:groups=>presets.prepareImport(groups,new Set(entities().map(e=>String(e.id)))),importPresetLibraries:groups=>presets.importPrepared(groups)});
      presets=createRocheReferencePresets({cleanProfile:engine.cleanProfile,initial:[...presetRows],persist:(id,items)=>storage('put','presets:'+id,items)});
      hook=createReferenceNetwork({protect:()=>protection,resolveContext:prompt=>resolveReferenceContext(runtime.store,prompt,Object.fromEntries(records)),profiles:()=>Object.fromEntries(records),native:()=>({entities}),engine,offlineCheck:createOfflineImageCheck({report:row=>engine.report(row),prepareRequest:(input,init)=>[...records.values()].some(p=>p.enabled&&(p.pairedPersonaId||runtime.store.personas.some(u=>String(u.id)===p.id)))?referenceAnnotateOfflineRequest(input,init):null}),presetLabel:profile=>{const snapshot=JSON.stringify(engine.cleanProfile(profile));const matches=presets.list(profile.id).filter(item=>JSON.stringify(item.profile)===snapshot);return matches.length?matches.map(item=>item.name).join(' / '):'自定义参考设置';},field:()=>field,toast,fetchBase:createReferenceResultTransport({fetchBase:previousFetch,mode:()=>resultMode,notify:toast})});
      for(const row of startupRecords.splice(0))engine.report(row);
      ui=createRocheReferenceUI(engine,{pluginMode:true,protection:()=>protection,saveProtection:async value=>{await storage('put','protection',value);protection=value;},connectionStatus:()=>coordinator.status().entryUnchanged?'插件已连接本页请求入口；仍以每次生成记录为准。':'页面请求入口已变化，是否兼容尚未确认。请刷新 Roche 后重新打开本面板。',presets,bindingStatus:id=>{const profile=records.get(String(id));if(!profile?.enabled)return '';const person=entities().find(e=>String(e.id)===String(id));return person?.faceLock?.enabled!==false&&person?.faceLock?.libraryItemId===profile.libraryId?'原生锁脸绑定正常；是否提交多图请查看生成记录。':'原生锁脸绑定已改变，请点击「套用并保存」或「保存参考设置」重新绑定。';},legacyImage:id=>{const p=entities().find(e=>String(e.id)===String(id));return runtime.store.faceLockLibrary.find(x=>x.id===p?.faceLock?.libraryItemId)?.image||'';},resultMode:()=>resultMode,saveResultMode:async value=>{await storage('put','resultMode',value);resultMode=value;},saveField:async value=>{await storage('put','field',value);field=value;}});
      scan();
    })().catch(error=>{loading=null;throw error;});return loading;
  }
  async function open(id){try{await initialize();if(disposed)return;ui.open({oaiReferenceImageField:field},id);}catch(e){api?.ui?.toast?.(e.message);if(!api)alert(e.message);}}
  function instanceAt(element){
    const roots=new Set();
    for(let n=element;n;n=n.parentElement){if(n.__vueParentComponent)return n.__vueParentComponent;if(n._vnode)roots.add(n._vnode);}
    const app=document.querySelector('#app');if(app?._vnode)roots.add(app._vnode);
    let found=null,depth=-1;const seen=new Set();
    function visit(v,owner,level){
      if(!v||typeof v!=='object'||seen.has(v)||seen.size>20000)return;seen.add(v);
      const current=v.component||owner;
      if(v.el&&(v.el===element||v.el.nodeType===1&&v.el.contains(element))&&current&&level>=depth){found=current;depth=level;}
      if(v.component?.subTree)visit(v.component.subTree,current,level+1);
      if(Array.isArray(v.children))for(const child of v.children)visit(child,current,level+1);
      if(v.suspense?.activeBranch)visit(v.suspense.activeBranch,current,level+1);
    }
    for(const root of roots)visit(root,null,0);return found;
  }
  function entityAt(element){
    for(let vm=instanceAt(element);vm;vm=vm.parent){
      const p=vm.props||{},name=vm.type?.__name||vm.type?.name;
      if(name==='FaceLockSettingsModal'&&p.entityId)return String(p.entityId);
      if(name==='ContactEdit'&&p.contactId)return String(p.contactId);
      if(p.personaId&&runtime?.store.personas.some(e=>String(e.id)===String(p.personaId)))return String(p.personaId);
      if((name==='ChatSettings'||name==='ChatSettingsIdentity')&&p.chatId&&runtime){
        const c=runtime.store.conversations?.find(c=>String(c.id)===String(p.chatId));
        const id=c?.contactId||c?.participants?.find(x=>runtime.store.contacts.some(e=>e.id===x));if(id)return String(id);
      }
    }return null;
  }
  function scan(){
    if(disposed)return;for(const button of inserted)if(!button.isConnected)inserted.delete(button);
    for(const label of document.querySelectorAll('h3,p,span,div')){
      if(label.children.length||label.closest('.rr-overlay,[data-rr-plus]'))continue;
      if(!['锁脸','绘图配置','人设描述'].includes(label.textContent.trim()))continue;
      const id=entityAt(label);if(!id)continue;
      const container=label.parentElement;if(!container||container.querySelector(':scope > [data-rr-plus]'))continue;
      const button=document.createElement('button');button.type='button';button.textContent='多图参考';button.dataset.rrPlus='entry';
      button.style.cssText='font:600 13px -apple-system,sans-serif;color:#171719;background:#fff;border:1px solid #e6e6e8;border-radius:999px;padding:9px 15px;margin:8px 0;cursor:pointer;white-space:nowrap;';
      button.onclick=event=>{event.preventDefault();event.stopPropagation();const currentId=entityAt(label);if(currentId)open(currentId);};
      container.append(button);inserted.add(button);
    }
  }
  function mount(container,hostApi){
    api=hostApi;const box=document.createElement('div');box.dataset.rrPlus='settings';box.style.cssText='padding:24px;font:15px/1.7 -apple-system,sans-serif;color:#171719;background:#fff;min-height:100%;box-sizing:border-box;';
    const title=document.createElement('h2');title.textContent='锁脸多图参考 · '+VERSION;
    const help=document.createElement('p');help.textContent='角色从「锁脸」进入，我的参考从「人设库 → 编辑人设 → 人设描述」进入。每人最多 4 张人物图。';
    const button=document.createElement('button');button.textContent='管理人物与画风参考';button.onclick=()=>open();
    const note=document.createElement('p');note.textContent='线下自动读取该聊天正在使用的人设；线上继续使用角色参考。实际提交张数可在「生成记录」核对。仅增强当前页面经过的 OAI 生图请求。';
    const status=document.createElement('p');status.textContent='正在检查兼容性……';
    box.append(title,help,button,note,status);container.append(box);mounts.set(container,()=>box.remove());
    initialize().then(()=>{if(!disposed)status.textContent='已连接当前账号版 Roche，参考图增强已就绪。';}).catch(e=>status.textContent=e.message);
  }
  function dispose(){if(disposed)return;disposed=true;clearInterval(lifecycleTimer);hook?.dispose();releaseFetch();ui?.dispose();observer?.disconnect();cancelAnimationFrame(frame);clearTimeout(noticeTimer);for(const b of inserted)b.remove();for(const clean of mounts.values())clean();historyWrite.finally(()=>db?.close());}
  window.RochePlugin.register({id:ID,name:'锁脸多图参考',version:VERSION,apps:[{id:ID+'-settings',name:'锁脸多图参考',icon:'photo_library',mount,unmount:c=>{mounts.get(c)?.();mounts.delete(c);}}]});
  window.__rocheReferencePlugin={dispose,open};
  observer=new MutationObserver(()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=0;scan();});});observer.observe(document.body,{childList:true,subtree:true});scan();
  initialize().catch(()=>{});
})();

})();
