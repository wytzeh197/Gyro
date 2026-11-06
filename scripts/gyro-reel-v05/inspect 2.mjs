import {readFileSync} from 'node:fs';
import {connect} from './cdp.mjs';
const c=await connect();try{
 const code=process.argv[2]?.endsWith('.js')?readFileSync(process.argv[2],'utf8'):process.argv[2];
 if(code)console.log(JSON.stringify(await c.evalJS(code),null,2));
 if(process.argv[3])await c.shot(process.argv[3]);
}finally{c.close()}
