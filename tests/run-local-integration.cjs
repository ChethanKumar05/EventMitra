require('dotenv').config();
const { Pool }=require('pg');
const {spawnSync}=require('node:child_process');
const suites={
  security:{file:'tests/security.integration.test.cjs',env:'TEST_DATABASE_URL'},
  owner:{file:'tests/owner-auth.integration.test.cjs',env:'OWNER_TEST_DATABASE_URL'}
};
(async()=>{
  const selected=process.argv.slice(2);
  const names=selected.length?selected:Object.keys(suites);
  for(const name of names)if(!suites[name])throw new Error('Unknown integration suite. Use security or owner.');
  const original=new URL(process.env.DATABASE_URL);
  const admin=new Pool({connectionString:original.toString(),connectionTimeoutMillis:3000,ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:true}:false});
  try{
    for(const suiteName of names){
      const suite=suites[suiteName],name='eventmitra_'+suiteName+'_'+Date.now()+'_test';
      try{
        await admin.query('CREATE DATABASE "'+name+'"');
        const target=new URL(original);target.pathname='/'+name;
        const result=spawnSync(process.execPath,['--test',suite.file],{stdio:'inherit',env:{...process.env,[suite.env]:target.toString()}});
        if(result.status!==0)process.exitCode=result.status??1;
      }finally{await admin.query('DROP DATABASE IF EXISTS "'+name+'" WITH (FORCE)');}
    }
  }finally{await admin.end();}
})().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
