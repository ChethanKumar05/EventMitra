import { GetObjectCommand,PutObjectCommand,S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UploadIdentity } from '../middleware/uploadAuth';
import { generateId } from '../utils/id';
import { httpError } from '../utils/httpError';

export async function uploadToS3(identity:UploadIdentity,input:{buffer:Buffer;contentType:string;extension:string;originalName:string;folder:string}){
  const bucket=process.env.AWS_S3_BUCKET,region=process.env.AWS_REGION;
  if(!bucket||!region)httpError(503,'AWS_REGION and AWS_S3_BUCKET must be configured');
  if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)||!/^[a-z0-9-]{1,63}$/.test(region))httpError(503,'Invalid S3 bucket or region configuration');
  const key=`uploads/${identity.type}/${identity.id}/${input.folder}/${generateId()}.${input.extension}`;
  const contentDisposition=`${input.contentType.startsWith('image/')?'inline':'attachment'}; filename="download.${input.extension}"`;
  const client=new S3Client({region,maxAttempts:3,requestHandler:{connectionTimeout:3000,requestTimeout:15000}});
  try{
    // Sign the preview before uploading; missing credentials cannot leave an uploaded orphan.
    const previewUrl=await getSignedUrl(client,new GetObjectCommand({Bucket:bucket,Key:key,ResponseContentDisposition:contentDisposition}),{expiresIn:600});
    await client.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:input.buffer,ContentType:input.contentType,ContentLength:input.buffer.length,
      ContentDisposition:contentDisposition,CacheControl:'private, max-age=0',ServerSideEncryption:'AES256',Metadata:{actor_type:identity.type,actor_id:identity.id}}));
    const originalName=input.originalName.replace(/\\/g,'/').split('/').pop()!.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,255);
    const objectUrl=new URL(previewUrl);objectUrl.search='';
    return {key,url:objectUrl.toString(),preview_url:previewUrl,preview_expires_in:600,original_name:originalName,content_type:input.contentType,size:input.buffer.length};
  }catch{httpError(503,'S3 upload failed; check bucket access, region and AWS credentials');}
  finally{client.destroy();}
}
