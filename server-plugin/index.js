import fs from 'node:fs/promises';
import path from 'node:path';

export const info = {
    id: 'rp-planner-storage',
    name: 'RP Planner Storage',
    description: 'Stores RP Planner schedules in per-chat JSON files.',
};

const VALID_KEY=/^chat_[a-z0-9]+$/;

function pathsFor(req,key) {
    if(!req.user?.directories?.root)throw new Error('User data directory unavailable');
    if(!VALID_KEY.test(key))throw new Error('Invalid chat key');
    const root=path.join(req.user.directories.root,'RP-planner');
    const chats=path.join(root,'chats');
    return {root,chats,file:path.join(chats,`${key}.json`)};
}

async function readJson(file) {
    try{return JSON.parse(await fs.readFile(file,'utf8'));}
    catch(err){if(err.code==='ENOENT')return null;throw err;}
}

async function writeAtomic(file,data) {
    const temp=`${file}.${process.pid}.tmp`;
    await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(temp,JSON.stringify(data,null,2),'utf8');
    await fs.rename(temp,file);
}

export async function init(router) {
    router.get('/health',(_req,res)=>res.json({ok:true,version:1}));

    router.get('/chat/:key',async(req,res)=>{
        try{
            const {file}=pathsFor(req,req.params.key);
            res.json({data:await readJson(file)});
        }catch(err){res.status(400).json({error:err.message});}
    });

    router.put('/chat/:key',async(req,res)=>{
        try{
            const {file}=pathsFor(req,req.params.key);
            const data=req.body?.data;
            if(!data||typeof data!=='object'||Array.isArray(data))return res.status(400).json({error:'Invalid data'});
            await writeAtomic(file,data);
            res.json({ok:true});
        }catch(err){res.status(400).json({error:err.message});}
    });

    router.delete('/chat/:key',async(req,res)=>{
        try{
            const {file,chats}=pathsFor(req,req.params.key);
            await fs.rm(file,{force:true});
            try{if((await fs.readdir(chats)).length===0)await fs.rmdir(chats);}catch(err){if(err.code!=='ENOENT'&&err.code!=='ENOTEMPTY')throw err;}
            res.status(204).end();
        }catch(err){res.status(400).json({error:err.message});}
    });
}
