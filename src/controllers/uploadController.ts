import multer from 'multer';
import { handler } from './securityValidation';
import { httpError } from '../utils/httpError';
import { success } from '../utils/response';
import { uploadToS3 } from '../services/uploadService';
import { UploadIdentity } from '../middleware/uploadAuth';

const maxBytes=10*1024*1024;
const formats:Record<string,{extension:string;matches:(buffer:Buffer)=>boolean}>={
  'image/jpeg':{extension:'jpg',matches:b=>b.length>=3&&b.subarray(0,3).equals(Buffer.from([0xff,0xd8,0xff]))},
  'image/png':{extension:'png',matches:b=>b.length>=8&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))},
  'image/gif':{extension:'gif',matches:b=>/^(GIF87a|GIF89a)$/.test(b.subarray(0,6).toString('ascii'))},
  'image/webp':{extension:'webp',matches:b=>b.length>=12&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP'},
  'application/pdf':{extension:'pdf',matches:b=>b.toString('ascii',0,5)==='%PDF-'},
};
const zip=(b:Buffer)=>b.length>=4&&[0x04034b50,0x06054b50,0x08074b50].includes(b.readUInt32LE(0));
for(const [mime,extension]of Object.entries({'application/zip':'zip','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx','application/vnd.openxmlformats-officedocument.presentationml.presentation':'pptx'}))formats[mime]={extension,matches:zip};
for(const [mime,extension]of Object.entries({'text/plain':'txt','text/csv':'csv'}))formats[mime]={extension,matches:b=>!b.includes(0)&&!new TextDecoder('utf-8',{fatal:false}).decode(b).includes('\uFFFD')};

const parse=multer({storage:multer.memoryStorage(),limits:{fileSize:maxBytes,files:1,fields:1,fieldSize:100,parts:2},
  fileFilter:(_req,file,callback)=>{if(!formats[file.mimetype])callback(Object.assign(new Error('Unsupported file type'),{status:415}));else callback(null,true);}}).single('file');

// Bound memory and upload traffic per authenticated identity in this API process.
const budgets=new Map<string,{start:number;count:number;active:number}>();
function claim(identity:UploadIdentity):()=>void{
  const now=Date.now(),key=`${identity.type}:${identity.id}`;
  for(const [id,budget]of budgets)if(!budget.active&&budget.start<now-900000)budgets.delete(id);
  const current=budgets.get(key)??{start:now,count:0,active:0};
  if(current.start<now-900000){current.start=now;current.count=0;}
  if(current.count>=20||current.active>=2||(!budgets.has(key)&&budgets.size>=10000))httpError(429,'Upload limit reached; try later');
  current.count++;current.active++;budgets.set(key,current);return()=>{current.active--;};
}

export const uploadFile=handler(async(req,res)=>{
  const identity=res.locals.uploadIdentity as UploadIdentity,release=claim(identity);
  try{
    if(!req.is('multipart/form-data'))httpError(415,'Send multipart/form-data with one file field named file');
    await new Promise<void>((resolve,reject)=>parse(req,res,error=>{
      if(error instanceof multer.MulterError)reject(Object.assign(new Error(error.code==='LIMIT_FILE_SIZE'?'File exceeds the 10 MiB limit':'Invalid multipart upload: '+error.code),{status:error.code==='LIMIT_FILE_SIZE'?413:400}));
      else if(error)reject(Object.assign(error,{status:(error as {status?:number}).status??400}));else resolve();
    }));
    for(const key of Object.keys(req.body??{}))if(key!=='folder')httpError(400,`Unexpected upload field: ${key}`);
    const folder=req.body?.folder??'general';
    if(typeof folder!=='string'||!/^[a-z0-9][a-z0-9_-]{0,49}$/.test(folder))httpError(400,'folder must be a simple 1-50 character lowercase name');
    const file=req.file;if(!file||file.size===0)httpError(400,'A nonempty file is required');
    const format=formats[file.mimetype];
    if(!format||!format.matches(file.buffer))httpError(415,'File contents do not match the declared file type');
    success(res,'File uploaded',await uploadToS3(identity,{buffer:file.buffer,contentType:file.mimetype,extension:format.extension,originalName:file.originalname,folder}),201);
  }finally{release();}
});
