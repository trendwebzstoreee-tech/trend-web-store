require('dotenv').config();
const express=require('express');
const session=require('express-session');
const helmet=require('helmet');
const multer=require('multer');
const path=require('path');
const crypto=require('crypto');
const app=express();
const ROOT=__dirname;
if(!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length<12 || !process.env.SESSION_SECRET || process.env.SESSION_SECRET.length<32){console.error('SECURITY SETUP REQUIRED: set ADMIN_PASSWORD (12+ chars) and SESSION_SECRET (32+ chars) in .env');process.exit(1)}
const defaults={products:[],categories:[{name:'Shoes',slug:'shoes',active:true},{name:'Sneakers',slug:'sneakers',active:true},{name:'Watches',slug:'watches',active:true},{name:'Slippers & Sandals',slug:'slippers-sandals',active:true}],banners:[],settings:{storeName:'TREND WEB STORE',whatsapp:'917356129415',instagram:'https://www.instagram.com/trend_web_store/',accent:'#111111',background:'#ffffff',textColor:'#111111',fontFamily:'Inter',headingFont:'Inter',announcement:'FRESH FINDS • NEW STYLES • ORDER ON WHATSAPP',payNowEnabled:true,codEnabled:true,codCancelLimit:3,qrImage:'',addressFields:['Full Name','Mobile Number','House / Flat Number','Street / Area','Landmark','City / Town','District','State','PIN Code'],returnEnabled:true,returnDays:7,activeTheme:'ios-light',showMarquee:true},orders:[],reviews:[]};
const MONGO_URI=process.env.MONGO_URI||process.env.MONGODB_URI;
if(!MONGO_URI){console.error('STARTUP STOPPED: MONGO_URI is not set. This store keeps ALL data in MongoDB Atlas and has no local-file fallback. Set MONGO_URI in Render > Environment.');process.exit(1)}
const clone=v=>JSON.parse(JSON.stringify(v));
const mongoose=require('mongoose');mongoose.set('strictQuery',true);
let webpush=null;try{webpush=require('web-push')}catch(e){console.error('web-push is not installed: push notifications are disabled')}
let pushReady=false,vapidPublic='';
// One real MongoDB collection per data type. Every product / order / customer is its own document.
const COLS={
products:{model:'Product',coll:'products',key:p=>p.slug,pos:true},
categories:{model:'Category',coll:'categories',key:c=>c.slug,pos:true},
banners:{model:'Banner',coll:'banners',key:b=>b.id,pos:true},
orders:{model:'Order',coll:'orders',key:o=>o.id,sort:{createdAt:-1}},
customers:{model:'Customer',coll:'customers',key:c=>c.email,sort:{createdAt:1}},
reviews:{model:'Review',coll:'reviews',key:r=>r.id,sort:{createdAt:-1}},
pushsubs:{model:'PushSub',coll:'pushsubs',key:p=>p.id,sort:{createdAt:1}}};
const M={},cache={},sigs={},writes={};let writeFails=0,Meta=null,Upload=null;
for(const[n,c]of Object.entries(COLS))M[n]=mongoose.model(c.model,new mongoose.Schema({_id:String},{strict:false,versionKey:false}),c.coll);
const docOf=(c,x,i)=>({...x,_id:c.key(x),...(c.pos?{pos:i}:{})});
function db(name){if(!(name in cache))cache[name]=clone(defaults[name]??[]);return clone(cache[name])}
async function persist(name,v){
if(name==='settings'){await Meta.replaceOne({_id:'settings'},{_id:'settings',value:v},{upsert:true});return}
const c=COLS[name];if(!c)throw new Error('Unknown collection '+name);
const old=sigs[name]||new Map(),next=new Map(),ops=[];
v.forEach((x,i)=>{const k=c.key(x);if(!k)return;const d=docOf(c,x,i),sig=JSON.stringify(d);next.set(k,sig);if(old.get(k)!==sig)ops.push({replaceOne:{filter:{_id:k},replacement:d,upsert:true}})});
for(const k of old.keys())if(!next.has(k))ops.push({deleteOne:{filter:{_id:k}}});
if(ops.length)await M[name].bulkWrite(ops,{ordered:false});
sigs[name]=next}
function save(name,val){const v=clone(val);cache[name]=v;
writes[name]=(writes[name]||Promise.resolve()).then(()=>persist(name,v)).catch(e=>{writeFails++;console.error('MongoDB save FAILED for "'+name+'":',e.message)})}
const flushWrites=()=>Promise.allSettled(Object.values(writes));
// If a database write fails, tell the browser instead of pretending everything was saved.
app.use((req,res,next)=>{if(req.method==='GET'||req.method==='HEAD')return next();const orig=res.json.bind(res),start=writeFails;
res.json=function(body){flushWrites().then(()=>{if(writeFails>start&&res.statusCode<400){res.status(503);return orig({error:'Could not save to the database. Please try again.'})}orig(body)});return res};next()});
async function initStorage(){
await mongoose.connect(MONGO_URI,{serverSelectionTimeoutMS:20000});
Meta=mongoose.model('Meta',new mongoose.Schema({_id:String,value:mongoose.Schema.Types.Mixed},{minimize:false,versionKey:false}),'meta');
Upload=mongoose.model('Upload',new mongoose.Schema({_id:String,mime:String,data:Buffer,createdAt:{type:Date,default:Date.now}},{versionKey:false}),'uploads');
for(const[n,c]of Object.entries(COLS)){const docs=await M[n].find().sort(c.sort||{pos:1}).lean();
const list=docs.map(d=>{const{_id,pos,...rest}=d;return rest});
sigs[n]=new Map(list.map((x,i)=>[c.key(x),JSON.stringify(docOf(c,x,i))]));
if(!list.length&&defaults[n]&&defaults[n].length&&!(await Meta.exists({_id:'seeded:'+n}))){cache[n]=clone(defaults[n]);await persist(n,cache[n]);await Meta.updateOne({_id:'seeded:'+n},{$set:{value:true}},{upsert:true});console.log('MongoDB: added default '+n)}
else cache[n]=list}
const st=await Meta.findById('settings').lean();cache.settings=st&&st.value?st.value:clone(defaults.settings);if(!st)await persist('settings',cache.settings);
const MS=require('connect-mongo'),MongoStore=MS.default||MS;sessionMw=mkSession(MongoStore.create({client:mongoose.connection.getClient(),collectionName:'sessions',ttl:30*24*3600,touchAfter:24*3600}));
if(webpush){try{const subject=process.env.VAPID_SUBJECT||process.env.PUBLIC_URL||(process.env.EMAIL_FROM?'mailto:'+process.env.EMAIL_FROM:'');
if(!/^(https:\/\/|mailto:)/.test(subject))throw new Error('set PUBLIC_URL (the https address of your store) in Render > Environment');
let k=process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY?{publicKey:process.env.VAPID_PUBLIC_KEY,privateKey:process.env.VAPID_PRIVATE_KEY}:null;
if(!k){const d=await Meta.findById('vapid').lean();if(d&&d.value&&d.value.publicKey)k=d.value;else{k=webpush.generateVAPIDKeys();await Meta.updateOne({_id:'vapid'},{$set:{value:k}},{upsert:true})}}
webpush.setVapidDetails(subject,k.publicKey,k.privateKey);vapidPublic=k.publicKey;pushReady=true;console.log('Push notifications ready.')}catch(e){console.error('Push notifications disabled:',e.message)}}
console.log(`MongoDB ready (db "${mongoose.connection.name}"): ${Object.keys(COLS).map(n=>n+' '+cache[n].length).join(', ')}. Nothing is stored on local disk.`)}
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,async()=>{await flushWrites();process.exit(0)});
app.disable('x-powered-by');app.set('trust proxy',1);app.use(helmet({contentSecurityPolicy:false,crossOriginResourcePolicy:{policy:'cross-origin'}}));app.use(express.json({limit:'2mb'}));app.use(express.urlencoded({extended:true,limit:'2mb'}));
const mkSession=store=>session({name:'trend.sid',secret:process.env.SESSION_SECRET,resave:false,saveUninitialized:false,store,cookie:{httpOnly:true,sameSite:'lax',secure:'auto',maxAge:6*60*60*1000}});
let sessionMw=mkSession(undefined);app.use((req,res,next)=>sessionMw(req,res,next));
const storage=multer.memoryStorage();
const upload=multer({storage,limits:{fileSize:5*1024*1024,files:12},fileFilter:(req,file,cb)=>{if(!/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype))return cb(new Error('Only JPG, PNG, WEBP or GIF images are allowed'));cb(null,true)}});
const auth=(req,res,next)=>req.session&&req.session.admin?next():res.status(401).json({error:'Admin login required'});
app.get('/api/store',(req,res)=>res.json({products:db('products').filter(p=>p.active!==false),categories:db('categories').filter(c=>c.active!==false),banners:db('banners').filter(b=>b.active!==false),settings:db('settings')}));
app.get('/api/product/:slug',(req,res)=>{const p=db('products').find(x=>x.slug===req.params.slug&&x.active!==false);if(!p)return res.status(404).json({error:'Product not found'});res.json(p)});
app.post('/api/admin/login',(req,res)=>{const supplied=String(req.body.password||'');const a=Buffer.from(supplied),b=Buffer.from(process.env.ADMIN_PASSWORD);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.status(401).json({error:'Incorrect password'});req.session.regenerate(err=>{if(err)return res.status(500).json({error:'Could not start session'});req.session.admin=true;res.json({ok:true})})});
app.post('/api/admin/logout',auth,(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/admin/data',auth,(req,res)=>res.json({products:db('products'),categories:db('categories'),banners:db('banners'),settings:db('settings'),orders:db('orders')}));
const ORDER_STATUSES=['Pending Confirmation','Confirmed','Rejected','Cancelled','Payment Verification Pending','Payment Verified','Shipped','Delivered','Return Requested','Return Approved','Return Received','Refund Pending','Refunded'];
const str=(v,max)=>String(v==null?'':v).trim().slice(0,max);
const validPhone=p=>{const d=String(p||'').replace(/\D/g,'');return d.length>=10&&d.length<=15&&(d.length!==10||/^[6-9]/.test(d))};
const sizeOrder=['xs','s','m','l','xl','xxl','xxxl'];
function cmpSize(a,b){const x=parseFloat(a.size),y=parseFloat(b.size);if(!isNaN(x)&&!isNaN(y))return x-y;if(!isNaN(x))return -1;if(!isNaN(y))return 1;const i=sizeOrder.indexOf(a.size.toLowerCase()),j=sizeOrder.indexOf(b.size.toLowerCase());return i>=0&&j>=0?i-j:a.size.localeCompare(b.size)}
function cleanSizes(list){const seen=new Set(),out=[];for(const s of Array.isArray(list)?list:[]){const obj=s&&typeof s==='object';const size=str(obj?s.size:s,12);if(!size||seen.has(size.toLowerCase()))continue;seen.add(size.toLowerCase());out.push({size,stock:obj?Math.max(0,Math.floor(Number(s.stock)||0)):1})}return out.sort(cmpSize)}
function normProduct(p){const o={...p};o.name=str(p.name,200);o.price=Math.max(0,Number(p.price)||0);o.variants=(Array.isArray(p.variants)?p.variants:[]).map(v=>({...v,color:str(v.color,60)||'Default',images:Array.isArray(v.images)?v.images.filter(x=>typeof x==='string'):[],sizes:cleanSizes(v.sizes),stock:Math.max(0,Math.floor(Number(v.stock)||0)),price:v.price===''||v.price==null?'':Math.max(0,Number(v.price)||0)}));if(Array.isArray(p.sizes))o.sizes=cleanSizes(p.sizes);o.brand=str(p.brand,60);o.specs=(Array.isArray(p.specs)?p.specs:[]).slice(0,30).map(x=>({k:str(x&&x.k,60),v:str(x&&x.v,200)})).filter(x=>x.k&&x.v);if(p.createdAt)o.createdAt=str(p.createdAt,40);return o}
const hits=new Map();
function limit(max,ms){return(req,res,next)=>{const now=Date.now(),k=req.ip+req.path,arr=(hits.get(k)||[]).filter(t=>now-t<ms);if(arr.length>=max)return res.status(429).json({error:'Too many requests. Please try again in a few minutes.'});arr.push(now);hits.set(k,arr);if(hits.size>5000)hits.clear();next()}}
const CANCELLABLE=['Pending Confirmation','Payment Verification Pending','Confirmed','Payment Verified'];
function setStatus(o,status,by){const at=new Date().toISOString();o.status=status;o.history=Array.isArray(o.history)?o.history:[];o.history.push({status,at,by});if(status==='Delivered'){o.deliveredAt=at;if(o.paymentMethod==='COD')o.paymentStatus='Paid on delivery'}if(status==='Payment Verified')o.paymentStatus='Paid'}
function publicOrder(o){const st=db('settings'),since=Date.now()-new Date(o.deliveredAt||o.updatedAt||o.createdAt).getTime();return{id:o.id,customer:o.customer,phone:o.phone,address:o.address,items:o.items,total:o.total,paymentMethod:o.paymentMethod,paymentStatus:o.paymentStatus,status:o.status,history:o.history||[],createdAt:o.createdAt,updatedAt:o.updatedAt,cancellationReason:o.cancellationReason||'',returnReason:o.returnReason||'',canCancel:CANCELLABLE.includes(o.status),canReturn:o.status==='Delivered'&&st.returnEnabled!==false&&since<=Number(st.returnDays??7)*864e5}}
const sameToken=(a,b)=>{a=Buffer.from(String(a||''));b=Buffer.from(String(b||''));return a.length===b.length&&crypto.timingSafeEqual(a,b)};
const last10=p=>String(p||'').replace(/\D/g,'').slice(-10);
const owns=(o,me)=>!!o.accountEmail&&o.accountEmail===me;
const EMAIL_PROVIDER=(process.env.EMAIL_PROVIDER||'console').toLowerCase();
const isEmail=e=>typeof e==='string'&&e.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
async function sendMail(to,subject,text){const name=db('settings').storeName||'Trend Web Store';
if(EMAIL_PROVIDER==='console'){console.log(`\n[EMAIL TEST MODE] To: ${to}\n${subject}\n${text}\n`);return}
const from=process.env.EMAIL_FROM;if(!from)throw Error('EMAIL_FROM is not set');
if(EMAIL_PROVIDER==='brevo'){if(!process.env.BREVO_API_KEY)throw Error('BREVO_API_KEY is not set');
const r=await fetch('https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'api-key':process.env.BREVO_API_KEY,'content-type':'application/json',accept:'application/json'},body:JSON.stringify({sender:{email:from,name},to:[{email:to}],subject,textContent:text}),signal:AbortSignal.timeout(15000)});
if(!r.ok){let m='';try{m=(await r.json()).message}catch{}throw Error('Brevo error: '+(m||r.status))}return}
if(EMAIL_PROVIDER==='smtp'){const nodemailer=require('nodemailer'),port=Number(process.env.SMTP_PORT||587);
const t=nodemailer.createTransport({host:process.env.SMTP_HOST,port,secure:port===465,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:20000});
await t.sendMail({from:`"${name}" <${from}>`,to,subject,text});return}
throw Error('Unknown EMAIL_PROVIDER (use console, brevo or smtp)')}
const cauth=(req,res,next)=>req.session&&req.session.customer?next():res.status(401).json({error:'Please log in with your phone number.'});
const otps=new Map(),hashOtp=(p,c)=>crypto.createHash('sha256').update(p+':'+c+':'+process.env.SESSION_SECRET).digest('hex');
setInterval(()=>{const n=Date.now();for(const[k,v]of otps)if(n>(v.exp||0)+3600e3&&(!v.sends.length||n-v.sends[v.sends.length-1]>3600e3))otps.delete(k)},600e3).unref();
const hashPw=(pw,salt=crypto.randomBytes(16).toString('hex'))=>new Promise((ok,no)=>crypto.scrypt(String(pw),salt,64,(e,k)=>e?no(e):ok({salt,hash:k.toString('hex')})));
const validPw=p=>typeof p==='string'&&p.length>=8&&p.length<=100;
const pendingSignup=new Map(),pendingLogin=new Map(),failed=new Map();
const LOGIN_OTP=String(process.env.LOGIN_OTP||'false').toLowerCase()!=='false';
const httpErr=(status,msg)=>Object.assign(Error(msg),{status});
const fail=(res,err)=>res.status(err.status||500).json({error:err.status?err.message:'Something went wrong. Please try again.'});
const emailOf=b=>{const e=String(b.email||'').trim().toLowerCase();if(!isEmail(e))throw httpErr(400,'Enter a valid email address.');return e};
async function issueOtp(e){const now=Date.now(),cur=otps.get(e)||{sends:[]};cur.sends=cur.sends.filter(t=>now-t<3600e3);
if(cur.sends.length&&now-cur.sends[cur.sends.length-1]<30e3)throw httpErr(429,'Please wait 30 seconds before requesting another OTP.');if(cur.sends.length>=5)throw httpErr(429,'Too many OTP requests. Try again in an hour.');
const code=String(crypto.randomInt(100000,1000000));try{await sendMail(e,`Your ${db('settings').storeName||'Trend Web Store'} verification code`,`Your verification code is ${code}.\nIt is valid for 5 minutes. If you did not request this, please ignore this email.`)}catch(err){console.error('OTP email failed:',err.message);throw httpErr(502,'Could not send the OTP email. Please try again later.')}
cur.sends.push(now);cur.hash=hashOtp(e,code);cur.exp=now+5*60e3;cur.tries=0;otps.set(e,cur);return{dev:EMAIL_PROVIDER==='console'}}
function checkOtp(e,code){const cur=otps.get(e);if(!cur||!cur.hash||Date.now()>cur.exp)throw httpErr(400,'OTP expired. Please request a new one.');if(cur.tries>=5){cur.hash=null;throw httpErr(429,'Too many wrong attempts. Please request a new OTP.')}cur.tries++;if(!sameToken(hashOtp(e,str(code,8)),cur.hash))throw httpErr(400,'Incorrect OTP. Please try again.');cur.hash=null}
function startSession(req,res,c){const admin=!!req.session.admin;req.session.regenerate(err=>{if(err)return res.status(500).json({error:'Could not log in'});if(admin)req.session.admin=true;req.session.customer={email:c.email};req.session.cookie.maxAge=30*864e5;res.json({ok:true,email:c.email,name:c.name})})}
app.post('/api/auth/signup',limit(8,10*60*1000),async(req,res)=>{try{const b=req.body||{},e=emailOf(b),name=str(b.name,80);if(name.length<2)throw httpErr(400,'Enter your full name.');if(!validPw(b.password))throw httpErr(400,'Password must be 8 to 100 characters.');if(db('customers').some(c=>c.email===e))throw httpErr(409,'This number is already registered. Please log in.');const j=await issueOtp(e);pendingSignup.set(e,{name,pw:await hashPw(b.password),exp:Date.now()+10*60e3});res.json({ok:true,dev:j.dev})}catch(err){fail(res,err)}});
app.post('/api/auth/verify-signup',limit(20,10*60*1000),(req,res)=>{try{const b=req.body||{},e=emailOf(b),p=pendingSignup.get(e);if(!p||Date.now()>p.exp)throw httpErr(400,'Signup expired. Please start again.');checkOtp(e,b.otp);const customers=db('customers');if(customers.some(c=>c.email===e))throw httpErr(409,'This number is already registered. Please log in.');const c={email:e,name:p.name,salt:p.pw.salt,hash:p.pw.hash,createdAt:new Date().toISOString()};customers.push(c);save('customers',customers);pendingSignup.delete(e);startSession(req,res,c)}catch(err){fail(res,err)}});
app.post('/api/auth/login',limit(15,15*60*1000),async(req,res)=>{try{const b=req.body||{},e=emailOf(b),f=failed.get(e)||{n:0,until:0};if(Date.now()<f.until)throw httpErr(429,'Too many wrong attempts. Try again in 15 minutes.');
const c=db('customers').find(x=>x.email===e),h=c?await hashPw(String(b.password==null?'':b.password).slice(0,100),c.salt):null;
if(!c||!sameToken(h.hash,c.hash)){f.n++;if(f.n>=5){f.until=Date.now()+15*60e3;f.n=0}failed.set(e,f);throw httpErr(400,'Incorrect phone number or password.')}failed.delete(e);
if(!LOGIN_OTP)return startSession(req,res,c);const j=await issueOtp(e);pendingLogin.set(e,Date.now()+10*60e3);res.json({ok:true,otpRequired:true,dev:j.dev})}catch(err){fail(res,err)}});
app.post('/api/auth/verify-login',limit(20,10*60*1000),(req,res)=>{try{const b=req.body||{},e=emailOf(b),exp=pendingLogin.get(e);if(!exp||Date.now()>exp)throw httpErr(400,'Login expired. Please log in again.');checkOtp(e,b.otp);const c=db('customers').find(x=>x.email===e);if(!c)throw httpErr(400,'Account not found.');pendingLogin.delete(e);startSession(req,res,c)}catch(err){fail(res,err)}});
app.post('/api/auth/forgot',limit(8,10*60*1000),async(req,res)=>{try{const e=emailOf(req.body||{});let dev=EMAIL_PROVIDER==='console';if(db('customers').some(c=>c.email===e))dev=(await issueOtp(e)).dev;res.json({ok:true,dev})}catch(err){fail(res,err)}});
app.post('/api/auth/reset',limit(20,10*60*1000),async(req,res)=>{try{const b=req.body||{},e=emailOf(b);if(!validPw(b.password))throw httpErr(400,'Password must be 8 to 100 characters.');const customers=db('customers'),c=customers.find(x=>x.email===e);if(!c)throw httpErr(400,'OTP expired. Please request a new one.');checkOtp(e,b.otp);const p=await hashPw(b.password);c.salt=p.salt;c.hash=p.hash;save('customers',customers);failed.delete(e);startSession(req,res,c)}catch(err){fail(res,err)}});
app.get('/api/admin/notifications',auth,(req,res)=>{const ev=[];for(const o of db('orders')){const h=Array.isArray(o.history)&&o.history.length?o.history:[{status:o.status,at:o.createdAt,by:'customer'}];h.forEach((x,i)=>{if(x.by!=='customer')return;const base={orderId:o.id,customer:o.customer,phone:o.phone,total:o.total,at:x.at};
if(i===0)ev.push({...base,type:'NEW_ORDER',text:'New order placed'});else if(x.status==='Cancelled')ev.push({...base,type:'CANCELLED',text:'Customer cancelled the order'+(o.cancellationReason?': '+o.cancellationReason:'')});else if(x.status==='Return Requested')ev.push({...base,type:'RETURN',text:'Customer requested a return'+(o.returnReason?': '+o.returnReason:'')})})}
ev.sort((a,b)=>String(b.at).localeCompare(String(a.at)));res.json(ev.slice(0,100))});
app.get('/api/auth/me',(req,res)=>{const c=req.session&&req.session.customer;const rec=c&&db('customers').find(x=>x.email===c.email);res.json(c?{email:c.email,name:rec?rec.name:''}:{email:null})});
app.post('/api/auth/logout',(req,res)=>{if(req.session)delete req.session.customer;res.json({ok:true})});
app.get('/api/my-orders',cauth,(req,res)=>{const me=req.session.customer.email;res.json(db('orders').filter(o=>owns(o,me)).map(publicOrder))});
const custAction=kind=>(req,res)=>{const me=req.session.customer.email,orders=db('orders'),i=orders.findIndex(o=>o.id===req.params.id),o=orders[i];if(!o||!owns(o,me))return res.status(404).json({error:'Order not found'});const reason=str((req.body||{}).reason,300);
if(kind==='cancel'){if(!CANCELLABLE.includes(o.status))return res.status(400).json({error:'This order can no longer be cancelled. Please contact us.'});o.cancellationReason=reason||'Cancelled by customer';setStatus(o,'Cancelled','customer')}
else{if(!publicOrder(o).canReturn)return res.status(400).json({error:'This order is not eligible for return.'});if(!reason)return res.status(400).json({error:'Please tell us the reason for the return.'});o.returnReason=reason;o.returnStatus='Requested';setStatus(o,'Return Requested','customer')}
o.updatedAt=new Date().toISOString();save('orders',orders);res.json(publicOrder(o))};
app.post('/api/my-orders/:id/cancel',cauth,limit(20,10*60*1000),custAction('cancel'));app.post('/api/my-orders/:id/return',cauth,limit(20,10*60*1000),custAction('return'));
async function notifyConfirmed(id){const orders=db('orders'),o=orders.find(x=>x.id===id);if(!o)return{ok:false,error:'Order not found'};const st=db('settings'),url=(process.env.PUBLIC_URL||'').replace(/\/$/,'');
const store=st.storeName||'Trend Web Store',text=`Your Order is Successfully Confirmed!\n\nOrder ID: ${o.id}\nStatus: Confirmed\nTotal: Rs ${o.total}\n\nWe will update you when it ships. Track it any time in My Orders${url?': '+url:'.'}\n\nThank you for shopping with ${store}.`;
let r;if(!o.accountEmail)r={ok:false,error:'This order has no customer email (placed before email login).'};else try{await sendMail(o.accountEmail,`${store}: Your Order is Confirmed (${o.id})`,text);r={ok:true}}catch(e){r={ok:false,error:e.message}}
const fresh=db('orders'),j=fresh.findIndex(x=>x.id===id);if(j>=0){fresh[j].notifications=[...(fresh[j].notifications||[]),{type:'confirmed',at:new Date().toISOString(),...r}].slice(-10);save('orders',fresh)}return r}
app.post('/api/admin/orders/:id/notify',auth,async(req,res)=>{res.json(await notifyConfirmed(req.params.id))});
app.get('/api/admin/orders',auth,(req,res)=>res.json(db('orders')));
app.put('/api/admin/orders/:id',auth,async(req,res)=>{const b=req.body||{},orders=db('orders'),i=orders.findIndex(o=>String(o.id)===String(req.params.id));if(i<0)return res.status(404).json({error:'Order not found'});const o={...orders[i]};let confirmedNow=false;
if(b.status!==undefined){if(!ORDER_STATUSES.includes(b.status))return res.status(400).json({error:'Invalid order status'});if(b.status!==o.status){setStatus(o,b.status,'admin');if(b.status==='Confirmed')confirmedNow=true}}
if(b.adminNote!==undefined)o.adminNote=str(b.adminNote,1000);
if(b.paymentStatus!==undefined)o.paymentStatus=str(b.paymentStatus,80);
if(b.customer!==undefined){const v=str(b.customer,120);if(v.length<2)return res.status(400).json({error:'Customer name is required'});o.customer=v}
if(b.phone!==undefined){if(!validPhone(b.phone))return res.status(400).json({error:'Enter a valid phone number'});o.phone=str(b.phone,25)}
if(b.address&&typeof b.address==='object'){const a=b.address,n={line:str(a.line,250),city:str(a.city,80),state:str(a.state,80),pincode:str(a.pincode,10)};if(!n.line||!n.city||!n.state)return res.status(400).json({error:'Address, city and state are required'});if(!/^\d{6}$/.test(n.pincode))return res.status(400).json({error:'Pincode must be 6 digits'});o.address=n}
o.updatedAt=new Date().toISOString();orders[i]=o;save('orders',orders);if(!confirmedNow)return res.json(o);const notify=await notifyConfirmed(o.id);res.json({...(db('orders').find(x=>x.id===o.id)||o),notify})});
app.delete('/api/admin/orders/:id',auth,(req,res)=>{const orders=db('orders'),next=orders.filter(o=>String(o.id)!==String(req.params.id));if(next.length===orders.length)return res.status(404).json({error:'Order not found'});save('orders',next);res.json({ok:true})});
app.post('/api/orders',cauth,limit(10,10*60*1000),(req,res)=>{const b=req.body||{},a=b.address||{},fail=m=>res.status(400).json({error:m});
const customer=str(b.customer,120),phone=str(b.phone,25),address={line:str(a.line,250),city:str(a.city,80),state:str(a.state,80),pincode:str(a.pincode,10)};
if(customer.length<2)return fail('Please enter your full name.');if(!validPhone(phone))return fail('Please enter a valid phone number.');if(!address.line)return fail('Please enter your house / street address.');if(!address.city)return fail('Please enter your city.');if(!address.state)return fail('Please select your state.');if(!/^\d{6}$/.test(address.pincode))return fail('Pincode must be 6 digits.');
if(!Array.isArray(b.items)||!b.items.length||b.items.length>20)return fail('Your order has no items.');
const products=db('products'),items=[];
for(const it of b.items){const p=products.find(x=>x.slug===it.slug&&x.active!==false);if(!p)return fail('A product in your order is no longer available.');const pn=normProduct(p),color=str(it.color,60),v=pn.variants.find(x=>x.color===color)||(color&&color!=='Default'?null:pn.variants[0])||{color:'Default',images:pn.images||[],sizes:pn.sizes||[],stock:Number(pn.stock)||0,price:''};if(!v)return fail(pn.name+': selected option is no longer available.');
const qty=Math.max(1,Math.min(99,Math.floor(Number(it.qty))||1)),sizes=v.sizes&&v.sizes.length?v.sizes:(pn.sizes||[]);let size='N/A';
if(sizes.length){size=str(it.size,12);const s=sizes.find(x=>x.size===size);if(!s)return fail(pn.name+': please select a valid size.');if(s.stock<qty)return fail(s.stock<=0?`${pn.name} (size ${size}) is out of stock.`:`Only ${s.stock} left of ${pn.name} (size ${size}).`)}else if(Number(v.stock)>0&&qty>Number(v.stock))return fail(`Only ${v.stock} left of ${pn.name}.`);
items.push({slug:pn.slug,name:pn.name,color:v.color,size,qty,price:Number(v.price)||Number(pn.price)||0,image:(v.images&&v.images[0])||(pn.images&&pn.images[0])||pn.image||''})}
const st=db('settings'),pm=b.paymentMethod==='PAY_NOW'?'PAY_NOW':'COD',utr=str(b.utr,30),orders=db('orders');
if(pm==='COD'&&st.codEnabled===false)return fail('Cash on Delivery is not available right now.');
if(pm==='PAY_NOW'){if(st.payNowEnabled===false||!st.upiId)return fail('Online payment is not available right now.');if(!/^[A-Za-z0-9]{8,24}$/.test(utr))return fail('Enter the UPI reference / UTR number from your payment app.');if(orders.some(o=>o.utr&&o.utr.toLowerCase()===utr.toLowerCase()))return fail('This UPI reference number was already used.')}
const digits=phone.replace(/\D/g,'').slice(-10);
if(pm==='COD'&&orders.filter(o=>owns(o,req.session.customer.email)&&o.status==='Cancelled').length>=Number(st.codCancelLimit||3))return res.status(403).json({error:'COD is unavailable for this number because of cancelled orders. Please use Pay Now.'});
const now=new Date().toISOString(),status=pm==='PAY_NOW'?'Payment Verification Pending':'Pending Confirmation';
const order={id:'TWS-'+Date.now().toString(36).toUpperCase()+crypto.randomBytes(1).toString('hex').toUpperCase(),accountEmail:req.session.customer.email,customer,phone,email:req.session.customer.email,address,items,total:items.reduce((s,x)=>s+x.price*x.qty,0),paymentMethod:pm,utr:pm==='PAY_NOW'?utr:'',paymentStatus:pm==='PAY_NOW'?'Verification Pending':'Pay on delivery',status,history:[{status,at:now,by:'customer'}],adminNote:'',createdAt:now,cancellationReason:'',returnStatus:'Not requested'};
orders.unshift(order);save('orders',orders);pushAll({title:'New order · ₹'+order.total,body:`${order.id} · ${order.customer} · ${order.items.reduce((n,x)=>n+x.qty,0)} item(s) · ${order.paymentMethod==='PAY_NOW'?'UPI payment (verify)':'Cash on Delivery'}`,tag:'order-'+order.id,url:'/admin/'}).catch(()=>{});res.status(201).json({ok:true,orderId:order.id,order:publicOrder(order)})});
const THEMES=['ios-light','midnight','amber','cyber','forest','slate','iconic'];
app.get('/api/theme',(req,res)=>{const s=db('settings');res.json({activeTheme:THEMES.includes(s.activeTheme)?s.activeTheme:'ios-light',showMarquee:s.showMarquee!==false})});
// ---- Reviews: real, customer-written reviews only. Ratings are calculated from them. ----
const reviewName=n=>{const p=String(n||'Customer').trim().split(/\s+/);return p.length>1?p[0]+' '+p[p.length-1][0].toUpperCase()+'.':p[0]};
const pubReview=r=>({id:r.id,slug:r.slug,name:r.name,rating:r.rating,title:r.title,text:r.text,verified:!!r.verified,createdAt:r.createdAt});
app.get('/api/reviews',(req,res)=>{const all=db('reviews'),acc={},summary={};for(const r of all){const a=acc[r.slug]||(acc[r.slug]={sum:0,count:0});a.sum+=r.rating;a.count++}
for(const k of Object.keys(acc))summary[k]={avg:Math.round(acc[k].sum/acc[k].count*10)/10,count:acc[k].count};
const slug=str(req.query.slug,120),names=new Map(db('products').map(p=>[p.slug,p.name]));
res.json({summary,top:all.filter(r=>r.rating>=4&&r.text).slice(0,12).map(r=>({...pubReview(r),product:names.get(r.slug)||''})),list:slug?all.filter(r=>r.slug===slug).slice(0,50).map(pubReview):[]})});
app.post('/api/reviews',cauth,limit(10,60*60*1000),(req,res)=>{const b=req.body||{},slug=str(b.slug,120),rating=Math.round(Number(b.rating)),title=str(b.title,80),text=str(b.text,1000),fail=(c,m)=>res.status(c).json({error:m});
if(!db('products').some(p=>p.slug===slug))return fail(404,'Product not found');if(!(rating>=1&&rating<=5))return fail(400,'Please choose 1 to 5 stars.');if(text.length<5)return fail(400,'Please write a few words about the product.');
const me=req.session.customer.email,cust=db('customers').find(c=>c.email===me);
const verified=db('orders').some(o=>o.accountEmail===me&&o.status==='Delivered'&&(o.items||[]).some(i=>i.slug===slug));
const reviews=db('reviews'),i=reviews.findIndex(r=>r.slug===slug&&r.customerEmail===me),now=new Date().toISOString();
const rec={id:i>=0?reviews[i].id:'RV-'+Date.now().toString(36)+crypto.randomBytes(2).toString('hex'),slug,customerEmail:me,name:reviewName(cust&&cust.name),rating,title,text,verified,createdAt:i>=0?reviews[i].createdAt:now,updatedAt:now};
if(i>=0)reviews[i]=rec;else reviews.unshift(rec);save('reviews',reviews);res.json({ok:true,review:pubReview(rec)})});
app.get('/api/admin/reviews',auth,(req,res)=>res.json(db('reviews')));
app.delete('/api/admin/reviews/:id',auth,(req,res)=>{const all=db('reviews'),next=all.filter(r=>r.id!==req.params.id);if(next.length===all.length)return res.status(404).json({error:'Review not found'});save('reviews',next);res.json({ok:true})});
// ---- Web Push for the installed admin app ----
const subId=ep=>crypto.createHash('sha256').update(ep).digest('hex').slice(0,32);
async function pushAll(payload){if(!pushReady)return;const body=JSON.stringify(payload),dead=[];
await Promise.all(db('pushsubs').map(async s=>{try{await webpush.sendNotification({endpoint:s.endpoint,keys:s.keys},body,{TTL:3600,urgency:'high'})}catch(e){if(e.statusCode===404||e.statusCode===410)dead.push(s.id);else console.error('Push failed:',e.statusCode||e.message)}}));
if(dead.length)save('pushsubs',db('pushsubs').filter(x=>!dead.includes(x.id)))}
app.get('/api/admin/push/key',auth,(req,res)=>pushReady?res.json({publicKey:vapidPublic}):res.status(503).json({error:'Push notifications are not available on this server'}));
app.post('/api/admin/push/subscribe',auth,(req,res)=>{if(!pushReady)return res.status(503).json({error:'Push notifications are not available'});const sb=req.body||{},k=sb.keys||{};
if(typeof sb.endpoint!=='string'||!/^https:\/\//.test(sb.endpoint)||sb.endpoint.length>800||typeof k.p256dh!=='string'||typeof k.auth!=='string')return res.status(400).json({error:'Invalid subscription'});
const list=db('pushsubs'),id=subId(sb.endpoint),now=new Date().toISOString(),i=list.findIndex(x=>x.id===id),rec={id,endpoint:sb.endpoint,keys:{p256dh:k.p256dh.slice(0,200),auth:k.auth.slice(0,100)},ua:str(req.headers['user-agent'],200),createdAt:i>=0?list[i].createdAt:now,updatedAt:now};
if(i>=0)list[i]=rec;else list.push(rec);if(list.length>20)list.splice(0,list.length-20);save('pushsubs',list);res.json({ok:true,devices:list.length});
pushAll({title:'Order alerts are ON',body:'You will get a notification here whenever a customer places a new order.',tag:'welcome',url:'/admin/'}).catch(()=>{})});
app.post('/api/admin/push/test',auth,async(req,res)=>{await pushAll({title:'Test notification',body:'Push notifications are working.',tag:'test',url:'/admin/'});res.json({ok:true,devices:db('pushsubs').length})});
app.get('/api/admin/storage-status',auth,async(req,res,next)=>{try{const c=mongoose.connection,counts={};for(const n of Object.keys(COLS))counts[n]=await M[n].countDocuments();counts.uploads=await Upload.countDocuments();res.json({storage:'MongoDB Atlas',connected:c.readyState===1,database:c.name,host:c.host,documentsInDatabase:counts,failedWrites:writeFails,localFiles:'none'})}catch(e){next(e)}});
app.post('/api/admin/upload',auth,upload.array('images',12),async(req,res,next)=>{try{const files=req.files||[];const out=[];for(const f of files){const ext=path.extname(f.originalname).toLowerCase().replace(/[^.a-z0-9]/g,''),id=Date.now()+'-'+crypto.randomBytes(5).toString('hex')+ext;await Upload.create({_id:id,mime:f.mimetype,data:f.buffer});out.push('/uploads/'+id)}res.json({files:out})}catch(e){next(e)}});
app.get('/uploads/:name',async(req,res,next)=>{try{const d=await Upload.findById(req.params.name);if(!d)return next();res.set({'Content-Type':d.mime,'Cache-Control':'public, max-age=86400','X-Content-Type-Options':'nosniff'});res.send(Buffer.from(d.data))}catch(e){next(e)}});
app.put('/api/admin/:kind',auth,(req,res)=>{const kind=req.params.kind;if(!['products','categories','banners','settings'].includes(kind))return res.status(404).json({error:'Unknown setting'});if(kind==='settings'){const old=db('settings');const next={...old,...req.body};if(next.whatsapp&&!/^\d{10,15}$/.test(String(next.whatsapp)))return res.status(400).json({error:'WhatsApp must contain country code and digits only'});next.upiId=String(next.upiId||'').trim().slice(0,80);next.upiName=String(next.upiName||'').trim().slice(0,60);if(next.activeTheme!==undefined&&!THEMES.includes(next.activeTheme))return res.status(400).json({error:'Unknown theme'});next.showMarquee=next.showMarquee!==false;for(const k of ['contactEmail','contactPhone','contactAddress'])if(next[k]!==undefined)next[k]=String(next[k]).trim().slice(0,200);if(next.upiId&&!/^[\w.\-]{2,64}@[A-Za-z][A-Za-z0-9.]{1,40}$/.test(next.upiId))return res.status(400).json({error:'Invalid UPI ID. Example: name@fam'});if(next.accent&&!/^#[0-9a-f]{6}$/i.test(next.accent))return res.status(400).json({error:'Invalid accent color'});if(next.codCancelLimit!==undefined)next.codCancelLimit=Math.max(1,Math.min(20,Number(next.codCancelLimit)||3));save(kind,next);return res.json(next)}if(!Array.isArray(req.body.items))return res.status(400).json({error:'Expected items array'});let items=req.body.items;if(kind==='products')items=items.filter(p=>p&&p.slug&&p.name).map(normProduct);if(items.length>1000)return res.status(400).json({error:'Too many items'});save(kind,items);res.json({ok:true,count:items.length})});
app.use('/uploads',(req,res)=>res.status(404).json({error:'Image not found'}));app.use('/admin',express.static(path.join(ROOT,'public'),{index:'admin.html'}));app.use(express.static(path.join(ROOT,'public')));
app.use((err,req,res,next)=>{console.error(err.message);res.status(err.status||(err instanceof multer.MulterError?400:500)).json({error:err.message||'Server error'})});
const port=Number(process.env.PORT)||3000;console.log('Email provider: '+EMAIL_PROVIDER+(EMAIL_PROVIDER==='console'?' (TEST MODE: OTP emails are printed here, not sent)':''));initStorage().then(()=>app.listen(port,'0.0.0.0',()=>console.log(`TREND WEB STORE running at http://127.0.0.1:${port}`))).catch(e=>{console.error('STARTUP FAILED:',e.message);process.exit(1)});
