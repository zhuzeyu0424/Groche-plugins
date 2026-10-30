// Read-only endpoints; no stored account cookie.
module.exports=async function(req,res){
res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');res.setHeader('Cache-Control','no-store');
if(req.method==='OPTIONS')return res.status(204).end();
const route=new URL(req.url,'https://localhost').pathname;
if(route==='/'&&req.method==='GET')return res.status(200).json({service:'Roche music',configured:!!process.env.MUSIC_ACCESS_KEY});
if(!process.env.MUSIC_ACCESS_KEY)return res.status(503).json({code:503});
if(req.headers.authorization!=='Bearer '+process.env.MUSIC_ACCESS_KEY)return res.status(401).json({code:401});
if(req.method!=='POST')return res.status(405).json({code:405});
let b=req.body||{};try{if(typeof b==='string')b=JSON.parse(b);}catch{return res.status(400).json({code:400});}
try{const api=require('@neteasecloudmusicapienhanced/api');let result;
if(route==='/search'){const keywords=String(b.keywords||'').trim().slice(0,120);if(keywords.length<2)return res.status(400).json({code:400});result=await api.search({keywords,limit:20,type:1});}
else if(route==='/song/url'){const id=String(b.id||'');if(!/^\d{1,20}$/.test(id))return res.status(400).json({code:400});result=await api.song_url({id,br:128000});}
else return res.status(404).json({code:404});return res.status(200).json(result.body);
}catch{return res.status(502).json({code:502,message:'Music source unavailable'});}};
