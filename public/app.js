const $=selector=>document.querySelector(selector);
const actions=['all','create','read','edit','delete','view'];
const labels={all:'All',create:'Create',read:'Read',edit:'Edit',delete:'Delete',view:'View'};
let me,screen='admins',page=1,renderVersion=0,matrixRole='',matrixAdmin='',matrixSearch='';
const state={admins:{},roles:{},modules:{},permissions:{}};
const config={
  admins:{resource:'admins',key:'admin_id',module:'admin_management',code:'admin_code',title:'Admins',fields:[['admin_name','Full name'],['admin_username','Username'],['role_type','Role'],['department','Department'],['admin_phone_number','Mobile number'],['admin_email','Email'],['status','Status'],['admin_code','Code'],['is_super_admin','Super admin']],filters:[['admin_name','Full name'],['admin_username','Username'],['role_id','Role'],['department','Department'],['admin_phone_number','Mobile number'],['admin_email','Email'],['status','Status'],['admin_code','Code'],['is_super_admin','Super admin']]},
  roles:{resource:'roles',key:'role_id',module:'role_management',code:'role_code',title:'Roles',fields:[['role_code','Code'],['role_type','Role']],filters:[['role_code','Code'],['role_type','Role']]},
  modules:{resource:'modules',key:'module_id',module:'module_management',code:'module_code',title:'Modules',fields:[['module_code','Code'],['module_name','Module'],['module_key','Key']],filters:[['module_code','Code'],['module_name','Module'],['module_key','Key']]},
  permissions:{resource:'admin-permissions',key:'permission_id',module:'permission_management',code:'permission_code',title:'Permissions',fields:[['permission_code','Code'],['admin_name','Admin'],['role_type','Role'],['module_name','Module'],...actions.map(action=>[action,labels[action]])],filters:[['permission_code','Code'],['admin_id','Admin'],['role_id','Role'],['module_id','Module'],...actions.map(action=>[action,labels[action]])]}
};
function el(tag,text,parent){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(parent)parent.append(node);return node;}
function button(text,parent,click,type='button'){const node=el('button',text,parent);node.type=type;if(click)node.onclick=click;return node;}
function message(error=''){$('#message').textContent=error.message||error;}
async function api(path,method='GET',body){
  const response=await fetch('/api/admin'+path,{method,credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const data=await response.json();if(!response.ok){if(response.status===401&&path!=='/auth/login')showLogin();throw new Error(data.message||'Request failed');}return data.data;
}
function showLogin(){me=null;renderVersion++;$('#workspace').hidden=true;$('#logout').hidden=true;$('#login').hidden=false;$('#identity').textContent='';$('#content').replaceChildren();}
function can(key){return me.is_super_admin||me.permissions.some(permission=>permission.module_key===key&&(permission.all||permission.read||permission.view));}
function access(){
  $('#identity').textContent=me.admin_name+' / '+me.role_type;
  $('#access').textContent=me.is_super_admin?'Super admin - manage roles, admins, main modules and module permissions.':'Your menus follow your assigned module permissions.';
  const summary=$('#module-access');summary.replaceChildren();
  for(const permission of me.permissions.filter(p=>actions.some(action=>p[action]))){const badge=el('span',permission.module_name,summary);badge.title=actions.filter(action=>permission[action]).map(action=>labels[action]).join(', ');}
  document.querySelectorAll('[data-screen]').forEach(node=>{node.hidden=node.dataset.screen==='matrix'?!me.is_super_admin:!can(config[node.dataset.screen].module);});
}
async function init(){
  me=await api('/auth/me');$('#login').hidden=true;$('#workspace').hidden=false;$('#logout').hidden=false;access();
  if(screen==='matrix'?!me.is_super_admin:!can(config[screen].module))screen=Object.keys(config).find(key=>can(config[key].module))||'';
  await render();
}
$('#login-form').onsubmit=async event=>{event.preventDefault();message();const form=event.currentTarget,submit=form.querySelector('button');submit.disabled=true;try{await api('/auth/login','POST',Object.fromEntries(new FormData(form)));form.reset();await init();}catch(error){message(error);}finally{submit.disabled=false;}};
$('#logout').onclick=async()=>{try{await api('/auth/logout','POST');showLogin();message();}catch(error){message(error);}};
document.querySelectorAll('[data-screen]').forEach(node=>node.onclick=()=>{screen=node.dataset.screen;page=1;render().catch(message);});
async function all(resource,query={}){const rows=[];let page=1,data;do{data=await api('/'+resource+'?'+new URLSearchParams({...query,page:String(page++),limit:'100'}));rows.push(...data.items);}while(rows.length<data.total);return rows;}
function option(select,value,title){const node=el('option',title,select);node.value=value;return node;}
function input(parent,name,title,value='',options){
  const label=el('label',title,parent),node=el(options?'select':'input',undefined,label);node.name=name;
  if(options){for(const [value,title]of options)option(node,value,title);}else node.type='text';node.value=value??'';return node;
}
async function filterToolbar(parent,key){
  const cfg=config[key],current=state[key],form=el('form',undefined,parent);form.className='toolbar';
  const searchGroup=el('div',undefined,form);searchGroup.className='search-group';
  const column=el('select',undefined,searchGroup);column.name='search_column';column.setAttribute('aria-label','Select search column');option(column,'all','Select column - all');cfg.fields.forEach(([key,title])=>option(column,key,title));column.value=current.search_column||'all';
  const search=el('input',undefined,searchGroup);search.type='search';search.name='search';search.placeholder='Search';search.setAttribute('aria-label','Search');search.maxLength=200;search.value=current.search||'';
  button('Search',searchGroup,null,'submit');
  const detail=el('details',undefined,form);detail.className='filter-popover';el('summary','Filter by',detail);
  const panel=el('div',undefined,detail);panel.className='filter-panel';el('strong','FILTER BY',panel);
  const fields=el('div',undefined,panel);fields.className='fields';
  let roles=[],admins=[],modules=[];
  if(me.is_super_admin)[roles,admins,modules]=await Promise.all([all('roles'),key==='permissions'?all('admins'):[],key==='permissions'?all('modules'):[]]);
  for(const [name,title]of cfg.filters){
    let options;
    if(name==='status')options=[['','All'],...['active','block','reject','delete'].map(value=>[value,value])];
    else if(name==='is_super_admin'||actions.includes(name))options=[['','All'],['true','Yes'],['false','No']];
    else if(name==='role_id'&&roles.length)options=[['','All'],...roles.map(row=>[row.role_id,row.role_type])];
    else if(name==='admin_id'&&admins.length)options=[['','All'],...admins.map(row=>[row.admin_id,row.admin_name])];
    else if(name==='module_id'&&modules.length)options=[['','All'],...modules.map(row=>[row.module_id,row.module_name])];
    input(fields,name,title,current[name]||'',options);
  }
  button('Apply filters',panel,null,'submit');
  button('Clear all',form,()=>{state[key]={};page=1;render().catch(message);}).className='secondary';
  form.onsubmit=event=>{event.preventDefault();const values=Object.fromEntries([...new FormData(form)].map(([key,value])=>[key,value.trim()]).filter(([,value])=>value!==''));state[key]={...values,sort_by:current.sort_by||'',sort_order:current.sort_order||'',limit:current.limit||'20'};page=1;render().catch(message);};
}
async function render(){
  const version=++renderVersion;message();const content=$('#content');content.replaceChildren();
  document.querySelectorAll('[data-screen]').forEach(node=>node.setAttribute('aria-current',String(node.dataset.screen===screen)));
  if(!screen){$('#title').textContent='Your access';el('p','No management modules are assigned. Ask a super admin to configure your access.',content);return;}
  $('#title').textContent=screen==='matrix'?'Permission matrix':config[screen].title;
  if(screen==='matrix'){await matrix(content,version);return;}
  const key=screen,cfg=config[key],query=new URLSearchParams({page:String(page),limit:'20',...Object.fromEntries(Object.entries(state[key]).filter(([,value])=>value!==''))});
  const data=await api('/'+cfg.resource+'?'+query);if(version!==renderVersion)return;
  await filterToolbar(content,key);if(version!==renderVersion)return;
  if(me.is_super_admin)button('Create '+(key==='permissions'?'permission':key==='admins'?'admin':key==='roles'?'role':'module'),content,()=>editor(key,{},content).catch(message));
  const wrapper=el('div',undefined,content);wrapper.className='table-wrap';const table=el('table',undefined,wrapper),head=el('tr',undefined,el('thead',undefined,table));
  for(const [field,title]of cfg.fields){const th=el('th',undefined,head);const selected=state[key].sort_by===field;th.setAttribute('aria-sort',selected?(state[key].sort_order==='desc'?'descending':'ascending'):'none');button(title+' '+(selected?(state[key].sort_order==='desc'?'\u2193':'\u2191'):'\u2195'),th,()=>{state[key].sort_by=field;state[key].sort_order=selected&&state[key].sort_order==='asc'?'desc':'asc';page=1;render().catch(message);});}
  el('th','Actions',head);const tbody=el('tbody',undefined,table);
  for(const row of data.items){const tr=el('tr',undefined,tbody);for(const [field]of cfg.fields){const value=row[field];const td=el('td',typeof value==='boolean'?(value?'Yes':'No'):String(value??'-'),tr);if(field==='status')td.className='status '+value;}
    const td=el('td',undefined,tr),menu=el('details',undefined,td);menu.className='row-menu';const summary=el('summary','\u22ee',menu);summary.setAttribute('aria-label','Actions for '+(row.admin_name||row.module_name||row.role_type||row.permission_code));
    const choices=el('div',undefined,menu);
    button(me.is_super_admin?'Edit':'View',choices,async()=>{try{await editor(key,await api('/'+cfg.resource+'/'+row[cfg.key]),content);}catch(error){message(error);}});
    if(me.is_super_admin){if(key==='admins')button('Permissions',choices,()=>{matrixRole=row.role_id;matrixAdmin=row.admin_id;screen='matrix';render().catch(message);});button('Delete',choices,async()=>{if(!confirm('Delete this record?'))return;try{await api('/'+cfg.resource+'/'+row[cfg.key],'DELETE');await refreshAccess();}catch(error){message(error);}}).className='danger';}
  }
  if(!data.items.length)el('p','No matching records.',wrapper);
  const pagination=el('div',undefined,content);pagination.className='pagination';button('Previous',pagination,()=>{page--;render().catch(message);}).disabled=page<=1;
  el('span',`Page ${page} of ${data.totalPages||1} / ${data.total} records`,pagination);
  button('Next',pagination,()=>{page++;render().catch(message);}).disabled=!data.hasNextPage;
  const size=el('select',undefined,pagination);size.setAttribute('aria-label','Page size');['10','20','50','100'].forEach(value=>option(size,value,value+' per page'));size.value=String(data.limit);size.onchange=()=>{state[key].limit=size.value;page=1;render().catch(message);};
}
async function refreshAccess(){me=await api('/auth/me');access();if(screen!=='matrix'&&screen&&!can(config[screen].module))screen=Object.keys(config).find(key=>can(config[key].module))||'';await render();}
async function editor(key,record,parent){
  $('#editor')?.remove();const cfg=config[key],id=record[cfg.key],form=el('form',undefined,parent);form.id='editor';form.className='card';el('h2',(id?'Edit ':'Create ')+cfg.title,form);
  if(id)input(form,cfg.code,'Code',record[cfg.code]).readOnly=true;
  const fields=el('div',undefined,form);fields.className='fields';let admins=[];
  if(key==='admins'){
    const roles=me.is_super_admin?await all('roles'):[{role_id:record.role_id,role_type:record.role_type}];input(fields,'admin_name','Full name',record.admin_name).required=true;const username=input(fields,'admin_username','Username (no spaces)',record.admin_username);username.required=true;username.pattern='[a-zA-Z0-9](?:[a-zA-Z0-9_.]|-){2,49}';username.minLength=3;username.maxLength=50;username.autocomplete='off';input(fields,'admin_email','Email',record.admin_email).type='email';form.elements.admin_email.required=true;
    input(fields,'role_id','Role',record.role_id||roles[0]?.role_id,roles.map(row=>[row.role_id,row.role_type])).required=true;
    input(fields,'department','Department',record.department);const phone=input(fields,'admin_phone_number','Mobile number',record.admin_phone_number);phone.type='tel';phone.pattern='[+]?[1-9][0-9]{6,14}';phone.maxLength=16;
    input(fields,'status','Status',record.status||'active',['active','block','reject','delete'].map(value=>[value,value]));
    const password=input(fields,'password','Password', '');password.type='password';password.required=!id;password.minLength=12;password.maxLength=256;password.autocomplete='new-password';if(id)password.placeholder='Leave blank to keep password';
    const superLabel=el('label','Super admin',fields);superLabel.className='check';const superBox=el('input',undefined,superLabel);superBox.type='checkbox';superBox.name='is_super_admin';superBox.checked=!!record.is_super_admin;
    el('p','Changing the role clears this admin\'s module grants. Assign permissions again after the change.',form);
  }else if(key==='roles')input(fields,'role_type','Role',record.role_type).required=true;
  else if(key==='modules'){input(fields,'module_name','Module name',record.module_name).required=true;input(fields,'module_key','Module key',record.module_key).placeholder='Optional on create: derived from name';}
  else{
    const modules=me.is_super_admin?await all('modules'):[{module_id:record.module_id,module_name:record.module_name}];admins=me.is_super_admin?await all('admins'):[{admin_id:record.admin_id,admin_name:record.admin_name,role_id:record.role_id,role_type:record.role_type}];const adminSelect=input(fields,'admin_id','Admin',record.admin_id||admins[0]?.admin_id,admins.map(row=>[row.admin_id,row.admin_name]));const role=input(fields,'role_id','Current role','');role.readOnly=true;
    const updateRole=()=>{const admin=admins.find(row=>row.admin_id===adminSelect.value);role.value=admin?.role_type||'';};adminSelect.onchange=updateRole;updateRole();
    input(fields,'module_id','Main module',record.module_id||modules[0]?.module_id,modules.map(row=>[row.module_id,row.module_name]));
    if(id){adminSelect.disabled=true;form.elements.module_id.disabled=true;}
    for(const action of actions){const label=el('label',labels[action],fields);label.className='check';const checkbox=el('input',undefined,label);checkbox.type='checkbox';checkbox.name=action;checkbox.checked=!!record[action];}
    form.elements.all.onchange=()=>actions.forEach(action=>{form.elements[action].checked=form.elements.all.checked;});
    for(const action of actions.filter(value=>value!=='all'))form.elements[action].onchange=()=>{if(!form.elements[action].checked)form.elements.all.checked=false;};
  }
  if(!me.is_super_admin)form.querySelectorAll('input,select').forEach(node=>node.disabled=true);
  else{const submit=button('Save',form,null,'submit');form.onsubmit=async event=>{event.preventDefault();submit.disabled=true;message();try{
    const body=Object.fromEntries(new FormData(form));delete body[cfg.code];
    if(key==='admins'){body.is_super_admin=form.elements.is_super_admin.checked;body.department=body.department||null;body.admin_phone_number=body.admin_phone_number||null;if(!body.password&&id)delete body.password;}
    if(key==='modules'&&!body.module_key)delete body.module_key;
    if(key==='permissions'){body.admin_id=form.elements.admin_id.value;body.module_id=form.elements.module_id.value;body.role_id=admins.find(row=>row.admin_id===body.admin_id)?.role_id;actions.forEach(action=>body[action]=form.elements[action].checked);}
    await api('/'+cfg.resource+(key!=='permissions'&&id?'/'+id:''),key==='permissions'?'POST':id?'PUT':'POST',key==='permissions'?[body]:body);await refreshAccess();
  }catch(error){message(error);}finally{submit.disabled=false;}};}
  button('Close',form,()=>form.remove()).className='secondary';form.scrollIntoView({behavior:'smooth',block:'nearest'});
}
async function matrix(parent,version){
  const [roles,admins]=await Promise.all([all('roles'),all('admins')]);if(version!==renderVersion)return;
  if(!roles.some(row=>row.role_id===matrixRole))matrixRole=roles[0]?.role_id||'';
  const candidates=admins.filter(row=>row.role_id===matrixRole);if(!candidates.some(row=>row.admin_id===matrixAdmin))matrixAdmin=candidates[0]?.admin_id||'';
  const controls=el('div',undefined,parent);controls.className='matrix-selectors';
  const role=input(controls,'role','Role',matrixRole,roles.map(row=>[row.role_id,row.role_type]));role.onchange=()=>{matrixRole=role.value;matrixAdmin='';render().catch(message);};
  const admin=input(controls,'admin','Admin',matrixAdmin,candidates.map(row=>[row.admin_id,row.admin_name]));admin.onchange=()=>{matrixAdmin=admin.value;render().catch(message);};
  if(!matrixAdmin){el('p','No admins are assigned to this role.',parent);return;}
  const matrix=await api('/admins/'+matrixAdmin+'/permissions');if(version!==renderVersion)return;
  const targetId=matrix.admin.admin_id,targetRole=matrix.admin.role_id,flags=new Map(matrix.permissions.map(row=>[row.module_id,{...row}]));
  if(matrix.admin.is_super_admin)el('p','Super admins automatically have every module action. Stored grants below do not restrict super-admin access.',parent);
  const search=el('input',undefined,parent);search.type='search';search.placeholder='Search main modules';search.setAttribute('aria-label','Search main modules');search.value=matrixSearch;
  const wrapper=el('div',undefined,parent);wrapper.className='table-wrap matrix';const table=el('table',undefined,wrapper),head=el('tr',undefined,el('thead',undefined,table));el('th','Main module',head);actions.forEach(action=>el('th',labels[action],head));const tbody=el('tbody',undefined,table);
  function draw(){tbody.replaceChildren();for(const row of flags.values()){if(!row.module_name.toLowerCase().includes(matrixSearch.toLowerCase()))continue;const tr=el('tr',undefined,tbody);el('td',row.module_name,tr);for(const action of actions){const checkbox=el('input',undefined,el('td',undefined,tr));checkbox.type='checkbox';checkbox.checked=!!row[action];checkbox.setAttribute('aria-label',row.module_name+': '+labels[action]);checkbox.onchange=()=>{row[action]=checkbox.checked;if(action==='all')actions.forEach(key=>row[key]=checkbox.checked);else if(!checkbox.checked)row.all=false;draw();};}}}
  search.oninput=()=>{matrixSearch=search.value;draw();};draw();
  const save=button('Save permissions',parent,async()=>{save.disabled=true;try{await api('/admins/'+targetId+'/permissions','PUT',{role_id:targetRole,permissions:[...flags.values()].map(row=>Object.fromEntries([['module_id',row.module_id],...actions.map(action=>[action,!!row[action]])]))});await refreshAccess();message('Permissions saved.');}catch(error){message(error);}finally{save.disabled=false;}});
}
init().catch(error=>{if(me)message(error);});
