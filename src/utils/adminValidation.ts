import { httpError } from './httpError';
export function normalizeEmail(value:unknown):string {
  if(typeof value!=='string')httpError(400,'Email is required');
  const address=value.trim().toLowerCase();
  const parts=address.split('@'),local=parts[0]??'',domain=parts[1]??'';
  if(address.length>255||parts.length!==2||local.length<1||local.length>64||local.startsWith('.')||local.endsWith('.')||local.includes('..')||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)||!domain.includes('.')||domain.split('.').some(label=>label.length>63||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))httpError(400,'Invalid email format');
  return address;
}
export function validateUsername(value:unknown):string {
  if(typeof value!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,49}$/.test(value))httpError(400,'Username is required: 3-50 letters, digits, dots, underscores or hyphens, starting with a letter or digit; whitespace is not allowed');
  return value.toLowerCase();
}
export function validatePhone(value:unknown):string {
  if(typeof value!=='string'||!/^\+?[1-9][0-9]{6,14}$/.test(value))httpError(400,'Phone must be a string of 7-15 digits with an optional leading +');
  return value;
}
