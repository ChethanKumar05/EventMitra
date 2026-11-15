import { RequestHandler } from 'express';
import { findSessionAdmin } from '../services/adminAuthService';
import { findSessionOwner } from '../services/ownerAuthService';
import { findSessionUser } from '../services/userAuthService';
import { sessionToken,securityHeaders } from './adminAuth';
import { ownerSessionToken } from './ownerAuth';
import { userSessionToken } from './userAuth';
import { httpError } from '../utils/httpError';

export type UploadIdentity = {type:'admin'|'user'|'owner';id:string};
export { securityHeaders as uploadSecurityHeaders };

export const authenticateUpload:RequestHandler=(req,res,next)=>{
  void(async()=>{
    const selected=req.get('X-Actor-Type');
    if(selected!==undefined&&!['admin','user','owner'].includes(selected))httpError(400,'X-Actor-Type must be admin, user or owner');
    const authorization=req.get('authorization');
    const bearer=authorization===undefined?undefined:/^Bearer ([a-f0-9]{64})$/.exec(authorization)?.[1];
    if(authorization!==undefined&&!bearer)httpError(401,'Invalid bearer token');
    const candidates=[
      {type:'admin' as const,token:bearer??sessionToken(req),find:findSessionAdmin},
      {type:'owner' as const,token:bearer??ownerSessionToken(req),find:findSessionOwner},
      {type:'user' as const,token:bearer??userSessionToken(req),find:findSessionUser},
    ];
    const identities:UploadIdentity[]=[];
    for(const candidate of candidates){
      if((selected&&selected!==candidate.type)||!candidate.token)continue;
      const profile=await candidate.find(candidate.token);
      if(profile)identities.push({type:candidate.type,id:(profile as unknown as Record<string,string>)[`${candidate.type}_id`]!});
    }
    if(!identities.length)httpError(401,'Admin, user or owner authentication required');
    if(identities.length>1)httpError(400,'Multiple sessions present; select X-Actor-Type');
    res.locals.uploadIdentity=identities[0];
    next();
  })().catch(next);
};
