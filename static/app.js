'use strict';
const app = document.querySelector('#app');
const state = { user: null, config: null, csrf: '', studies: [], filter: 'all', search: '', detail: null, edit: null, busy: false, generation: 0 };
const symbols = {
 grid:'<rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/>',
 chart:'<path d="M4 20h16M7 16V9m5 7V4m5 12v-5"/>',
 wallet:'<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 8h16M16 12h5v5h-5z"/>',
 arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
 back:'<path d="M19 12H5m5-5-5 5 5 5"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',
 check:'<path d="m5 12 4 4L19 6"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 users:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v2"/>',
 logout:'<path d="M9 4H4v16h5m5-12 4 4-4 4m-5-4h12"/>',
 search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
 leaf:'<path d="M5 19C2 8 10 3 20 4c0 10-5 17-15 15zm0 0L16 8"/>',
 lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${symbols[name] || symbols.grid}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statuses = {draft:'Черновик',moderating:'На модерации',open:'Сбор ответов',closed:'Завершено'};
const letter = n => String.fromCharCode(65+n);
const dateText = seconds => seconds ? new Date(seconds*1000).toLocaleDateString('ru-RU',{day:'numeric',month:'short'}) : '—';
const percent = n => Number(n).toLocaleString('ru-RU',{minimumFractionDigits:1,maximumFractionDigits:1}) + '%';
const roleName = role => role === 'owner' ? 'Заказчик' : 'Участник';
const badge = s => `<span class="pill ${esc(s.status)}"><span class="dot"></span>${statuses[s.status]}</span>`;
const optionName = (study,id) => { const n=study.options.findIndex(o=>o.id===id); return n<0?'—':`${letter(n)} · ${study.options[n].text || 'Изображение'}`; };
const pointWord = n => n%10===1&&n%100!==11?'балл':n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?'балла':'баллов';
let toastTimer, pollTimer;
function toast(message) { const el=document.querySelector('#toast'); el.textContent=message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('show'),4500); }
async function api(path, {method='GET',body}={}) {
 const response=await fetch('/api'+path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json','X-Manyvo-Client':'web','X-CSRF-Token':state.csrf},body:body===undefined?undefined:JSON.stringify(body)});
 const data=await response.json();
 if(!response.ok) { if(response.status===401 && path!=='/login'){state.user=null;state.csrf=''; renderLogin();} throw new Error(data.error || 'Не удалось загрузить данные.'); }
 return data;
}
function shell(content, section='studies', label='Исследования') {
 const u=state.user,owner=u.role==='owner';
 app.innerHTML=`<div class="shell"><aside class="sidebar"><a class="brand" href="#/">manyvo<span>✳</span></a><div class="nav-label eyebrow">Рабочее пространство</div><nav class="nav" aria-label="Основная навигация"><a class="${section==='studies'?'active':''}" href="#/">${icon('grid')}${owner?'Мои исследования':'Исследования'}</a>${owner?`<a class="${section==='metrics'?'active':''}" href="#/metrics">${icon('chart')}Метрики</a>`:`<a class="${section==='history'?'active':''}" href="#/history">${icon('wallet')}Мои баллы</a>`}</nav><div class="sidebar-bottom"><div class="sidebar-note">${icon('leaf')}<strong>${owner?'Решения с опорой на людей':'Ваше мнение имеет значение'}</strong><p>${owner?'Личные предпочтения и прогноз большинства — два взгляда на ваш следующий шаг.':'Выбирайте, прогнозируйте и получайте баллы за участие.'}</p></div><div class="user-block"><div class="avatar">${esc(u.name[0])}</div><div><div class="user-name">${esc(u.name)}</div><div class="user-role">${roleName(u.role)}</div></div><button class="icon-button" data-action="logout" title="Выйти" aria-label="Выйти" style="margin-left:auto">${icon('logout')}</button></div></div></aside><div class="workspace"><header class="topbar"><span class="crumb">Рабочее пространство &nbsp;/&nbsp; ${esc(label)}</span><div class="topbar-right">${state.config.demo?'<span class="pill">Деморежим</span>':'<span class="live-indicator"><span class="dot"></span>Manyvo workspace</span>'}${owner?`<div class="avatar" title="${esc(u.name)}">${esc(u.name[0])}</div>`:`<a class="text-link" href="#/history">${icon('wallet')}${u.balance} ${pointWord(u.balance)}</a>`}<button class="icon-button mobile-logout" data-action="logout" aria-label="Выйти">${icon('logout')}</button></div></header><main class="workspace-main" id="main">${content}<footer class="page-foot"><span>manyvo · От мнений к обоснованным решениям</span><span>Личный выбор. Прогноз. Проверка.</span></footer></main></div></div>`;
}
function renderLogin() {
 clearTimeout(pollTimer);
 app.innerHTML=`<main class="login" id="main"><section class="login-story"><a href="#/" class="brand">manyvo<span>✳</span></a><div class="login-pitch"><div class="eyebrow" style="color:#b6cda3;margin-bottom:22px">Прогнозные микроисследования</div><h1>Хорошие решения<br>начинаются<br>с <em>другого мнения.</em></h1><p>Узнайте, что выбирают люди, чего ждут от большинства и как это соотносится с реальностью.</p><div class="login-art" aria-hidden="true"><div>A</div><div>B ↗</div><div>C</div></div></div><div class="login-story-foot">ЛИЧНЫЙ ВЫБОР &nbsp; / &nbsp; ПРОГНОЗ &nbsp; / &nbsp; ФАКТ</div></section><section class="login-form-side"><div class="login-box">${state.config?.demo?'<span class="login-mode">Локальная демонстрация</span>':''}<h2>Рады видеть вас</h2><p>Войдите, чтобы продолжить исследование.</p><form id="login-form"><div class="field"><label>Электронная почта<input name="email" type="email" autocomplete="username" placeholder="you@example.com" required></label></div><div class="field"><label>Пароль<input name="password" type="password" autocomplete="current-password" placeholder="Ваш пароль" required></label></div><div id="login-error" class="error-text" role="alert"></div><button class="button wide" type="submit">Войти в Manyvo ${icon('arrow')}</button></form>${state.config?.demo_accounts?.length?`<div class="demo-divider"><p>Для знакомства с продуктом выберите аккаунт.<br>Демо-пароль: <strong>manyvo-demo</strong></p><div class="demo-accounts">${state.config.demo_accounts.map(a=>`<button class="demo-account" data-action="demo-fill" data-email="${esc(a.email)}">${esc(a.name)} · ${roleName(a.role)}</button>`).join('')}</div></div>`:''}<p class="login-note">Два ответа — один вклад в лучшее решение.</p></div></section></main>`;
}
function art() {return '<div class="hero-art" aria-hidden="true"><div class="art-card"><span class="art-letter">a</span></div><div class="art-card"><span class="art-flower"></span></div></div>';}
function stats(items) {return `<div class="stats">${items.map(([title,value,desc,ico])=>`<div class="stat"><div class="stat-top"><span>${esc(title)}</span>${icon(ico)}</div><span class="stat-number">${esc(value)}</span><span class="stat-description">${esc(desc)}</span></div>`).join('')}</div>`;}
function newCard() {return `<a class="new-card" href="#/new"><span class="new-icon">${icon('plus')}</span><h3>Следующий вопрос — ваш</h3><p>Создайте исследование и узнайте мнение аудитории.</p></a>`;}
function studyCard(s) {
 const owner=state.user.role==='owner', answered=!!s.my_answer;
 const action=owner?(s.status==='draft'?'Продолжить':s.status==='closed'?'Смотреть результаты':'Открыть исследование'):answered?(s.status==='closed'?'Мой результат':'Ответ принят'):'Участвовать';
 const snippet=s.question||'Добавьте вопрос и варианты, когда будете готовы.';
 return `<article class="study-card"><div class="row spread card-top">${badge(s)}<span class="study-code">#${s.id.slice(0,6).toUpperCase()}</span></div><h3>${esc(s.title||'Новое исследование')}</h3><p>${esc(snippet.length>110?snippet.slice(0,110)+'…':snippet)}</p><div class="card-meta">${icon('users')}<span>${esc(s.country||'Аудитория не выбрана')} ${s.age_min?`· ${s.age_min}–${s.age_max} лет`:''}</span></div>${owner&&s.status!=='draft'?`<div class="progress" aria-label="Принято ${s.count} из ${s.quota} ответов"><span style="width:${Math.min(100,100*s.count/s.quota)}%"></span></div>`:''}<div class="row spread card-bottom"><span class="muted">${owner?(s.status==='draft'?`${s.options.length} из 5 вариантов`:`${s.count} / ${s.quota} ответов`):(answered?'1 базовый балл начислен':'1 балл + бонус за прогноз')}</span><a class="text-link" href="#/study/${s.id}">${action}${icon('arrow')}</a></div></article>`;
}
function renderList() {
 const owner=state.user.role==='owner',all=state.studies;
 const shown=all.filter(s=>(state.filter==='all'||(state.filter==='answered'?s.my_answer:s.status===state.filter))&&(`${s.title} ${s.question}`).toLowerCase().includes(state.search.toLowerCase()));
 const tabs=owner?[['all','Все'],['open','Активные'],['draft','Черновики'],['closed','Завершённые']]:[['all','Все'],['open','Открытые'],['answered','Мои ответы']];
 const summary=owner?[['Всего исследований',all.length,'в вашем пространстве','grid'],['Собирают ответы',all.filter(s=>s.status==='open').length,'прямо сейчас','users'],['Принято ответов',all.reduce((n,s)=>n+s.count,0),'личный выбор + прогноз','chart']]:[['Доступно сейчас',all.filter(s=>s.status==='open'&&!s.my_answer).length,'подходят вашему профилю','grid'],['Ваши ответы',all.filter(s=>s.my_answer).length,'вклад в исследования','check'],['Баланс',state.user.balance,'за участие и прогнозы','wallet']];
 shell(`<div class="row spread page-heading"><div><h1>${owner?'Мои исследования':'Новый взгляд — ваш'}</h1><p>${owner?'Задавайте вопросы. Сравнивайте варианты. Выбирайте увереннее.':'Выберите для себя. Предскажите выбор большинства.'}</p></div>${owner?`<a class="button" href="#/new">${icon('plus')}Создать исследование</a>`:''}</div><section class="hero"><div><div class="eyebrow">${owner?'От вопроса к решению':'Небольшой выбор. Большая польза.'}</div><h2>${owner?'Не гадайте, какой вариант сработает. Спросите людей.':'Что нравится вам?<br>А что выберет большинство?'}</h2><p>${owner?'От 2 до 5 вариантов, нужная аудитория и два независимых взгляда: личное предпочтение и прогноз.':'Ответьте на два коротких вопроса. Получите 1 балл за участие и ещё 1, если ваш прогноз окажется верным.'}</p></div>${art()}</section>${stats(summary)}<div class="toolbar"><div class="tabs" role="group" aria-label="Фильтр исследований">${tabs.map(([value,label])=>`<button class="tab ${state.filter===value?'active':''}" data-action="filter" data-value="${value}">${label}<span class="tab-count">${all.filter(s=>value==='all'||(value==='answered'?s.my_answer:s.status===value)).length}</span></button>`).join('')}</div><label class="search">${icon('search')}<input id="study-search" type="search" placeholder="Найти исследование" aria-label="Найти исследование" value="${esc(state.search)}"></label></div><div class="study-grid" id="study-grid">${shown.map(studyCard).join('')}${owner&&state.filter==='all'&&!state.search?newCard():''}</div>${!shown.length&&!(owner&&state.filter==='all'&&!state.search)?'<div class="empty">'+icon('search')+'<h3>Пока ничего не найдено</h3><p>Попробуйте другой фильтр или вернитесь позже.</p></div>':''}`);
}
function back() {return `<a class="back" href="#/">${icon('back')}К исследованиям</a>`;}
function detailHeading(s) {return `${back()}<div class="detail-heading">${badge(s)}<h1>${esc(s.title||'Новое исследование')}</h1><p>${esc(s.question)}</p></div>`;}
function collectEdit() {
 const form=document.querySelector('#edit-form');
 if(!form)return;
 const data=new FormData(form);
 const number=name=>data.get(name)===''?null:Number(data.get(name));
 Object.assign(state.edit,{title:data.get('title'),question:data.get('question'),quota:number('quota'),age_min:number('age_min'),age_max:number('age_max'),country:data.get('country')});
 state.edit.options.forEach((o,i)=>o.text=data.get('option-'+i)||'');
}
function renderEditor(s) {
 const e=state.edit;
 shell(`${back()}<div class="page-heading"><h1>${s.title?'Редактировать исследование':'С чего начнём?'}</h1><p>Сохраните идею сейчас. Опубликуйте, когда всё будет готово.</p></div>${s.moderation_reason?`<div class="notice error" role="alert">${esc(s.moderation_reason)}</div>`:''}<form id="edit-form"><div class="form-layout"><div><section class="panel"><h2>01 &nbsp; Ваш вопрос</h2><div class="field"><label>Название исследования<input name="title" maxlength="120" placeholder="Например, выбираем заголовок для лендинга" value="${esc(e.title)}"></label></div><label>Вопрос для участников<textarea name="question" maxlength="500" placeholder="Добавьте контекст, который поможет сделать выбор">${esc(e.question)}</textarea></label><div class="field-help">До 500 символов. Формулируйте вопрос одинаково для всех вариантов.</div></section><section class="panel"><div class="row spread"><h2>02 &nbsp; Варианты</h2><span class="small muted">${e.options.length} / 5</span></div>${e.options.map((o,i)=>`<div class="option-editor"><div class="row spread" style="margin-bottom:11px"><span class="option-label">ВАРИАНТ ${letter(i)}</span><button type="button" class="option-remove" data-action="remove-option" data-index="${i}" aria-label="Удалить вариант ${letter(i)}">Удалить</button></div><label class="hidden" for="option-${i}">Текст варианта ${letter(i)}</label><textarea id="option-${i}" name="option-${i}" maxlength="500" placeholder="Текст варианта ${letter(i)}">${esc(o.text)}</textarea>${o.image?`<img class="option-preview" src="${esc(o.image)}" alt="Изображение варианта ${letter(i)}"><button class="option-remove" type="button" data-action="remove-image" data-index="${i}">Убрать изображение</button>`:''}<label class="upload">Добавить изображение · PNG или JPEG до 5 МБ<input type="file" accept="image/png,image/jpeg" data-image-index="${i}" aria-label="Изображение варианта ${letter(i)}"></label></div>`).join('')}<button class="button secondary wide" type="button" data-action="add-option" ${e.options.length>=5?'disabled':''}>${icon('plus')}Добавить вариант</button><div class="field-help">Для публикации нужны 2–5 заполненных вариантов. В черновике можно оставить меньше.</div></section><section class="panel"><h2>03 &nbsp; Аудитория и сбор</h2><div class="form-grid"><label>Страна<select name="country"><option value="">Выберите страну</option>${['Россия','Казахстан','Беларусь','Армения','Грузия','Другая'].map(c=>`<option ${e.country===c?'selected':''}>${c}</option>`).join('')}</select></label><label>Количество ответов<input name="quota" type="number" min="2" max="500" step="1" value="${e.quota??''}" placeholder="50 по умолчанию"></label><label>Возраст от<input name="age_min" type="number" min="18" max="120" step="1" placeholder="18" value="${e.age_min??''}"></label><label>Возраст до<input name="age_max" type="number" min="18" max="120" step="1" placeholder="65" value="${e.age_max??''}"></label></div><div class="field-help">Сбор завершится по квоте или через 24 часа после публикации.</div></section><div class="form-actions"><button class="button secondary" type="submit" name="intent" value="save">Сохранить черновик</button><button class="button" type="submit" name="intent" value="publish">Отправить на модерацию ${icon('arrow')}</button></div></div><aside class="form-side"><div class="panel"><h3>Как это работает</h3><ul class="side-list"><li><span>01</span>Вы добавляете варианты и выбираете аудиторию.</li><li><span>02</span>Материалы проходят проверку перед публикацией.</li><li><span>03</span>Участники выбирают для себя и прогнозируют большинство.</li><li><span>04</span>После закрытия вы видите оба распределения и можете добавить бизнес-факт.</li></ul><div class="notice" style="margin:0">После публикации варианты нельзя изменить: все должны отвечать на один и тот же вопрос.</div></div></aside></div></form>`, 'studies', 'Новое исследование');
}
function renderOwner(s) {
 if(s.status==='draft'){state.edit=structuredClone(s);renderEditor(s);return;}
 if(s.status==='moderating'){shell(`${detailHeading(s)}<section class="panel empty">${icon('clock')}<h2>Проверяем материалы</h2><p>После проверки исследование откроется автоматически.<br>Пока проверка идёт, материалы нельзя редактировать.</p></section>`);schedulePoll();return;}
 if(s.status==='closed'){renderReport(s);return;}
 shell(`${detailHeading(s)}<section class="panel"><div class="meta-grid"><div><strong>${s.count} / ${s.quota}</strong><small>принято ответов</small></div><div><strong>${s.age_min}–${s.age_max}</strong><small>лет · ${esc(s.country)}</small></div><div><strong>${dateText(s.deadline)}</strong><small>сбор до ${new Date(s.deadline*1000).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}</small></div></div><div class="progress" style="margin-top:25px"><span style="width:${100*s.count/s.quota}%"></span></div></section><div class="notice">${icon('lock')} Распределения появятся после закрытия исследования. Пока доступно только число принятых ответов.</div><section class="panel"><h2>Варианты исследования</h2><div class="option-list">${s.options.map((o,i)=>`<div class="option-tile"><span class="option-label">ВАРИАНТ ${letter(i)}</span>${o.image?`<img src="${esc(o.image)}" alt="Вариант ${letter(i)}">`:''}<p>${esc(o.text)}</p></div>`).join('')}</div></section>`);
 schedulePoll();
}
function choiceGroup(s,name,heading,description,step) {
 return `<section class="panel question-step"><h2><span class="step-number">${step}</span>${heading}</h2><p>${description}</p><div class="option-list">${s.options.map((o,i)=>`<label class="choice-tile"><input type="radio" name="${name}" value="${o.id}" required><div><span class="option-label">ВАРИАНТ ${letter(i)}</span><p>${esc(o.text)}</p>${o.image?`<img src="${esc(o.image)}" alt="Изображение варианта ${letter(i)}">`:''}</div></label>`).join('')}</div></section>`;
}
function renderParticipant(s) {
 if(s.my_answer){renderReceipt(s);return;}
 if(s.status==='closed'){shell(`${detailHeading(s)}<div class="empty"><h2>Исследование завершено</h2><p>Вы не успели отправить ответ. Посмотрите другие исследования.</p><a href="#/" class="button">Найти исследование</a></div>`);return;}
 shell(`${detailHeading(s)}<div class="notice">1 балл за два ответа. Ещё 1 — если ваш прогноз совпадёт с лидером личных выборов. Прогноз может совпадать с вашим предпочтением.</div><form id="answer-form">${choiceGroup(s,'personal_id','Что выбрали бы вы?','Ваше личное предпочтение. Здесь нет правильного или неправильного ответа.',1)}${choiceGroup(s,'prediction_id','А что выберет большинство?','Предскажите самый популярный личный выбор других участников.',2)}<div class="form-actions"><button type="submit" class="button">Отправить два ответа ${icon('arrow')}</button></div><p class="small muted" style="margin-top:15px;text-align:right">После отправки изменить ответы нельзя.</p></form>`);
}
function renderReceipt(s) {
 const closed=s.status==='closed',points=s.points||{},total=(points.base||0)+(points.bonus||0);
 shell(`${back()}<section class="receipt"><div class="success-icon">${icon('check')}</div><h2>${closed?'Ваш результат готов':'Спасибо за ваш выбор'}</h2><p>${esc(s.title)}<br>${closed?'Исследование завершено. Вот ваш итог.':'Ответ принят. Мы сохранили оба выбора и начислили базовый балл.'}</p><div class="panel"><div class="field"><div class="eyebrow">Личный выбор</div><p style="margin:9px 0 0">${esc(optionName(s,s.my_answer.personal_id))}</p></div><div><div class="eyebrow">Прогноз большинства</div><p style="margin:9px 0 0">${esc(optionName(s,s.my_answer.prediction_id))}</p></div></div>${closed?`<div class="panel"><h3>Лидеры личных выборов</h3><p class="small">${(s.personal_leaders||[]).map(id=>esc(optionName(s,id))).join('<br>')||'Нет ответов'}</p>${!s.complete?'<p class="small muted">Выборка неполная. Бонус рассчитан по принятым ответам.</p>':''}</div>`:''}<div class="point-badge"><span>Базовый балл</span><strong>+${points.base||0}</strong></div><div class="point-badge"><span>${closed?'Бонус за прогноз':'Бонус после закрытия'}</span><strong>${closed?'+'+(points.bonus||0):'до +1'}</strong></div><p style="margin-top:20px">${closed?`Итого за исследование: ${total} ${pointWord(total)}.`:'Бонус определится, когда завершится сбор ответов.'}</p><a class="button secondary" href="#/">К исследованиям ${icon('arrow')}</a></section>`);
 if(!closed)schedulePoll();
}
function chart(s,field,title,orange=false) {
 const rows=s[field],leaders=s[field==='personal'?'personal_leaders':'prediction_leaders'];
 return `<section class="panel"><h2><span class="legend-dot ${orange?'orange':''}"></span>${title}</h2>${rows.length?rows.map(r=>`<div class="chart-row"><div class="chart-label"><span>${letter(r.position)} · ${esc(r.text||'Изображение')}</span><strong>${r.count} · ${percent(r.percent)}</strong></div><div class="chart-track"><div class="chart-fill ${orange?'prediction':''}" style="width:${r.percent}%"></div></div></div>`).join(''):'<p class="small muted">Нет ответов</p>'}<p class="leader-note">${leaders.length>1?'Ничья. Лидеры':'Лидер'}: ${leaders.map(id=>letter(s.options.findIndex(o=>o.id===id))).join(', ')||'нет'}</p></section>`;
}
function renderReport(s) {
 const fact=s.comparison.fact;
 shell(`${detailHeading(s)}${!s.complete?'<div class="notice">Выборка неполная. Итоги относятся к '+s.count+' принятым ответам из '+s.quota+' запланированных.</div>':''}<section class="panel"><div class="meta-grid"><div><strong>${s.count} / ${s.quota}</strong><small>принято ответов</small></div><div><strong>${s.complete?'Полная':'Неполная'}</strong><small>выборка</small></div><div><strong>${dateText(s.closed_at)}</strong><small>исследование закрыто</small></div></div></section><div class="result-columns">${chart(s,'personal','Личные предпочтения')}${chart(s,'predictions','Прогноз большинства',true)}</div><div class="comparison"><div class="row spread"><h3>Прогноз и реальный результат</h3>${fact?`<span class="pill">Версия ${fact.version}</span>`:''}</div><h2 style="margin:10px 0">${esc(s.comparison.label)}</h2><p>${fact?'Сравниваем лидера прогнозов с лидером бизнес-метрики. Личные предпочтения и начисленные баллы не меняются.':'Добавьте результаты реального запуска, чтобы проверить прогноз панели.'}</p></div><form id="fact-form" class="panel"><h2>${fact?'Обновить фактические данные':'Добавить фактические данные'}</h2><p class="small muted">Одна метрика для всех вариантов и общий период. Чем выше значение, тем лучше результат.</p><div class="fact-grid"><label>Метрика<input name="metric" maxlength="120" required placeholder="Например, кликабельность" value="${esc(fact?.metric||'')}"></label><label>Единица измерения<input name="unit" maxlength="40" required placeholder="Например, % или заказы" value="${esc(fact?.unit||'')}"></label><label>Начало периода<input type="date" name="start_date" required value="${esc(fact?.start_date||'')}"></label><label>Конец периода<input type="date" name="end_date" required value="${esc(fact?.end_date||'')}"></label></div><label class="check-label"><input type="checkbox" name="is_rate" ${fact?.is_rate?'checked':''}>Это ставка или доля, например CTR. Укажу знаменатель для каждого варианта.</label>${s.options.map((o,i)=>{const v=fact?.values.find(v=>v.option_id===o.id);return `<div class="fact-variant"><div class="small" style="margin-bottom:12px">${letter(i)} · ${esc(o.text||'Изображение')}</div><div class="fact-grid"><label>Значение<input type="number" name="value-${o.id}" min="0" step="any" required value="${v?.value??''}" placeholder="0"></label><label class="denominator-field ${fact?.is_rate?'':'hidden'}">Знаменатель<input type="number" name="denominator-${o.id}" min="0.00000001" step="any" value="${v?.denominator??''}" placeholder="Например, число показов" ${fact?.is_rate?'required':''}></label></div></div>`;}).join('')}<div class="form-actions" style="margin-top:22px"><button class="button" type="submit">${fact?'Сохранить новую версию':'Сохранить и сверить'} ${icon('check')}</button></div></form>`);
}
async function renderHistory() {
 const {history}=await api('/history');
 shell(`<div class="page-heading"><h1>Мои баллы</h1><p>За каждым баллом — ваше мнение или точный прогноз.</p></div><div class="balance-hero"><div class="eyebrow">Ваш баланс</div><div class="balance-number">${state.user.balance}<span style="font-size:20px;letter-spacing:0;margin-left:12px">${pointWord(state.user.balance)}</span></div><p>1 балл за принятую пару ответов. Ещё 1 — за верный прогноз.</p></div><section class="panel"><h2>История начислений</h2>${history.length?`<div class="table-wrap"><table><thead><tr><th>Исследование</th><th>Начисление</th><th>Дата</th><th>Баллы</th></tr></thead><tbody>${history.map(h=>`<tr><td><a href="#/study/${h.study_id}">${esc(h.title)}</a></td><td>${h.kind==='base'?'Участие':'Верный прогноз'}</td><td>${dateText(h.created_at)}</td><td style="color:#6f8e4b">+${h.amount}</td></tr>`).join('')}</tbody></table></div>`:'<p class="small muted">Начислений пока нет. Отправьте первую пару ответов в доступном исследовании.</p>'}</section>`,'history','Мои баллы');
}
async function renderMetrics() {
 const m=await api('/metrics');
 shell(`<div class="page-heading"><h1>Метрики исследований</h1><p>Фактические данные вашего пространства. Цели пилота ещё предстоит проверить.</p></div>${stats([['Завершили ответы',m.completion_percent===null?'—':percent(m.completion_percent),`${m.pairs} пар / ${m.starts} уникальных начал`,'check'],['Совпадение с фактом',m.agreement_percent===null?'—':percent(m.agreement_percent),`${m.comparable} однозначных сверок`,'chart'],['Исследований',m.studies.length,'с момента публикации','grid']])}<div class="notice">Завершение — доля открывших исследование участников, которые отправили оба ответа. Цель пилота — ≥80%. Скорость набора проверяем при квоте 50: цель — не больше 60 минут до 50-го ответа. Синтетические демоданные не подтверждают достижение этих целей.</div><section class="panel"><h2>Набор ответов</h2><div class="table-wrap"><table><thead><tr><th>Исследование</th><th>Начали</th><th>Ответили</th><th>До 50-го ответа</th></tr></thead><tbody>${m.studies.map(s=>`<tr><td><a href="#/study/${s.id}">${esc(s.title)}</a></td><td>${s.starts}</td><td>${s.pairs} / ${s.quota}</td><td>${s.quota!==50?'Другая квота':s.t50_seconds===null?'50 ответов не набраны':Math.ceil(s.t50_seconds/60)+' мин'}</td></tr>`).join('')||'<tr><td colspan="4">Пока нет опубликованных исследований.</td></tr>'}</tbody></table></div></section><p class="small muted">Ничьи при сверке: ${m.ties}. Нет ответов или факта: ${m.missing}. Они не включены в долю однозначных совпадений.</p>`,'metrics','Метрики');
}
function schedulePoll() {clearTimeout(pollTimer);pollTimer=setTimeout(async()=>{if(document.hidden||!state.user){schedulePoll();return;}const s=await api('/studies/'+state.detail.id).catch(()=>null);if(!s)return;if(s.status!==state.detail.status||s.count!==state.detail.count){state.detail=s;state.user=await api('/me');state.user.role==='owner'?renderOwner(s):renderParticipant(s);}else schedulePoll();},4000);}
async function route() {
 clearTimeout(pollTimer);
 const generation=++state.generation;
 if(!state.user){renderLogin();return;}
 const route=(location.hash||'#/').slice(1), owner=state.user.role==='owner';
 try {
  state.user=await api('/me');
  if(generation!==state.generation)return;
  if(route==='/new'&&owner){const s=await api('/studies',{method:'POST',body:{}});location.hash='/study/'+s.id;return;}
  if(route==='/history'&&!owner){await renderHistory();return;}
  if(route==='/metrics'&&owner){await renderMetrics();return;}
  const match=route.match(/^\/study\/([a-f0-9]{32})$/);
  if(match){const s=await api('/studies/'+match[1]);if(generation!==state.generation)return;state.detail=s;owner?renderOwner(s):renderParticipant(s);return;}
  const result=await api('/studies');if(generation!==state.generation)return;state.studies=result.studies;renderList();
 }catch(error){if(state.user)shell(`${back()}<div class="empty"><h2>Не удалось открыть страницу</h2><p>${esc(error.message)}</p><a class="button secondary" href="#/">Вернуться к исследованиям</a></div>`);toast(error.message);}
}
app.addEventListener('click',async event=>{
 const button=event.target.closest('[data-action]');if(!button)return;
 const action=button.dataset.action;
 if(action==='demo-fill'){const form=document.querySelector('#login-form');form.elements.email.value=button.dataset.email;form.elements.password.value='manyvo-demo';form.querySelector('[type=submit]').focus();return;}
 if(action==='filter'){state.filter=button.dataset.value;renderList();return;}
 if(action==='logout'){try{await api('/logout',{method:'POST',body:{}});state.user=null;state.csrf='';location.hash='/';renderLogin();}catch(e){toast(e.message);}return;}
 if(['add-option','remove-option','remove-image'].includes(action)){collectEdit();if(action==='add-option'&&state.edit.options.length<5)state.edit.options.push({text:'',image:null});if(action==='remove-option')state.edit.options.splice(Number(button.dataset.index),1);if(action==='remove-image')state.edit.options[Number(button.dataset.index)].image=null;renderEditor(state.detail);}
});
app.addEventListener('input',event=>{
 if(event.target.id==='study-search') {state.search=event.target.value;const value=state.search,start=event.target.selectionStart;renderList();const search=document.querySelector('#study-search');search.focus();if(search.type!=='search')search.setSelectionRange(start,start);search.value=value;}
});
app.addEventListener('change',async event=>{
 const input=event.target;
 if(input.matches('[data-image-index]')){
  const file=input.files[0];if(!file)return;
  if(!['image/png','image/jpeg'].includes(file.type)||file.size>5*1024*1024){toast('Выберите PNG или JPEG до 5 МБ.');input.value='';return;}
  collectEdit();const index=Number(input.dataset.imageIndex);
  try{state.edit.options[index].image=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});renderEditor(state.detail);}catch{toast('Не удалось прочитать изображение.');}
 }
 if(input.name==='is_rate'){document.querySelectorAll('.denominator-field').forEach(label=>{label.classList.toggle('hidden',!input.checked);label.querySelector('input').required=input.checked;});}
});
app.addEventListener('submit',async event=>{
 event.preventDefault();if(state.busy)return;
 const form=event.target;
 state.busy=true;const buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
 try {
  if(form.id==='login-form') {const data=new FormData(form);const login=await api('/login',{method:'POST',body:Object.fromEntries(data)});state.csrf=login.csrf;state.user=await api('/me');await route();return;}
  if(form.id==='edit-form'){
   collectEdit();const publish=event.submitter?.value==='publish';const s=await api('/studies/'+state.detail.id,{method:'PUT',body:state.edit});state.detail=s;state.edit=structuredClone(s);
   if(publish){shell(`${back()}<div class="panel empty">${icon('clock')}<h2>Проверяем материалы</h2><p>Проверяем все варианты перед публикацией. Это может занять до полутора минут.</p></div>`);state.detail=await api('/studies/'+s.id+'/publish',{method:'POST',body:{}});renderOwner(state.detail);toast(state.detail.status==='open'?'Исследование опубликовано':state.detail.moderation_reason||'Проверка не завершена');}
   else{renderEditor(s);toast('Черновик сохранён');}return;
  }
  if(form.id==='answer-form'){const payload=Object.fromEntries(new FormData(form));state.detail=await api('/studies/'+state.detail.id+'/answer',{method:'POST',body:payload});state.user=await api('/me');renderParticipant(state.detail);toast('Ответы приняты. +1 базовый балл');return;}
  if(form.id==='fact-form'){
   const values=new FormData(form),is_rate=values.has('is_rate');
   const payload={metric:values.get('metric'),unit:values.get('unit'),start_date:values.get('start_date'),end_date:values.get('end_date'),is_rate,values:state.detail.options.map(o=>({option_id:o.id,value:Number(values.get('value-'+o.id)),denominator:is_rate?Number(values.get('denominator-'+o.id)):null}))};
   state.detail=await api('/studies/'+state.detail.id+'/fact',{method:'POST',body:payload});renderReport(state.detail);toast('Факт сохранён. Сверка обновлена');return;
  }
 }catch(error){if(form.id==='login-form'){const el=document.querySelector('#login-error');if(el)el.textContent=error.message;}else toast(error.message);}
 finally{state.busy=false;buttons.forEach(b=>b.disabled=false);}
});
window.addEventListener('hashchange',route);
async function start(){try{state.config=await api('/config');try{state.user=await api('/me');state.csrf=state.user.csrf;}catch{state.user=null;}await route();}catch(error){app.innerHTML=`<main class="boot" id="main"><span class="brand">manyvo<span>✳</span></span><h2 style="margin-top:40px">Не удалось подключиться</h2><p>${esc(error.message)}</p><button class="button" id="retry">Повторить</button></main>`;document.querySelector('#retry').addEventListener('click',start);}}
start();
