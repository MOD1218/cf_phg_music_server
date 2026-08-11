// 搜索服务 - 对齐 lx-music-desktop-master 实现
import { aesEncryptECB } from '../utils/aes.ts';

export interface SearchResult {
  platform: string;
  total: number;    // 搜索结果总数
  allPage: number; // 总页数
  results: Array<{id:string;name:string;singer:string;albumName:string;interval:string;source:string;songmid?:string;hash?:string;img?:string}>;
}

async function md5(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('MD5', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function pkcs7Pad(data: Uint8Array): Uint8Array {
  const pad = 16 - (data.length % 16);
  const result = new Uint8Array(data.length + (pad === 16 ? 0 : pad));
  result.set(data);
  for (let i = data.length; i < result.length; i++) result[i] = pad;
  return result;
}

function aesEcbEncryptPure(data: ArrayBuffer, key: string): ArrayBuffer {
  const keyBytes = new TextEncoder().encode(key).slice(0, 16);
  const encrypted = aesEncryptECB(new Uint8Array(data), keyBytes);
  return encrypted.buffer;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}
class KuwoSearchService {
  async search(kw:string,p:number,l:number):Promise<SearchResult> {
    try {
      const url=`http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(kw)}&pn=${p-1}&rn=${l}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1`;
      const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0','Referer':'http://www.kuwo.cn'}});
      const d=await r.json();
      const total=Number(d.TOTAL||d.total||0);
      return {platform:'kw',total,allPage:total?Math.ceil(total/l):0,results:(d.abslist||[]).map((i:any)=>({
        id:String(i.MUSICRID).replace('MUSIC_',''),name:i.NAME,singer:i.ARTIST,
        albumName:i.ALBUM||'',interval:i.DURATION?Math.floor(i.DURATION/60)+':'+String(i.DURATION%60).padStart(2,'0'):'00:00',
        source:'kw',songmid:String(i.MUSICRID).replace('MUSIC_',''),img:i.albumpic?.replace('{size}','100')||''
      }))};
    }catch(e){console.error('[KuwoSearch]',e);return{platform:'kw',total:0,allPage:0,results:[]};}
  }
}
class KugouSearchService {
  async search(kw:string,p:number,l:number):Promise<SearchResult> {
    try {
      const url=`http://msearchcdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(kw)}&page=${p}&pagesize=${l}&showtype=1`;
      const r=await fetch(url,{headers:{
        'User-Agent':'Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30',
        'KG-RC':'1'
      }});
      const rawText=await r.text();
      if(!rawText.trim()) return{platform:'kg',results:[]};
      const d=JSON.parse(rawText);
      const info=d.data?.info||[];
      const total=Number(d.data?.total||0);
      if(info.length>0) return{platform:'kg',total,allPage:total?Math.ceil(total/l):0,results:info.map((i:any)=>({
        id:i.album_id||'',name:i.songname||'',singer:i.singername||'',
        albumName:i.album_name||'',interval:i.duration?Math.floor(i.duration/60)+':'+String(i.duration%60).padStart(2,'0'):'00:00',
        source:'kg',hash:i.hash||'',img:''
      }))};
      return{platform:'kg',total:0,allPage:0,results:[]};
    }catch(e){console.error('[KugouSearch]',e);return{platform:'kg',total:0,allPage:0,results:[]}};
  }
}
class QQMusicSearchService {
  async search(kw:string,p:number,l:number):Promise<SearchResult> {
    try {
      const body=JSON.stringify({
        comm:{ct:'11',cv:'14090508',v:'14090508',tmeAppID:'qqmusic',phonetype:'EBG-AN10',deviceScore:'553.47',devicelevel:'50',newdevicelevel:'20',rom:'HuaWei/EMOTION/EmotionUI_14.2.0',os_ver:'12',OpenUDID:'0',OpenUDID2:'0',QIMEI36:'0',udid:'0',chid:'0',aid:'0',oaid:'0',taid:'0',tid:'0',wid:'0',uid:'0',sid:'0',modeSwitch:'6',teenMode:'0',ui_mode:'2',nettype:'1020',v4ip:''},
        req:{module:'music.search.SearchCgiService',method:'DoSearchForQQMusicMobile',param:{search_type:0,query:kw,page_num:p,num_per_page:l,highlight:0,nqc_flag:0,multi_zhida:0,cat:2,grp:1,sin:0,sem:0}}
      });
      const r=await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg',{method:'POST',headers:{'User-Agent':'QQMusic 14090508(android 12)','Content-Type':'application/json'},body});
      const d=await r.json();
      const songs=(d?.req?.data?.body?.item_song||[]).filter((i:any)=>i&&i.name&&i.file?.media_mid);
      const total=Number(d?.req?.data?.meta?.estimate_sum||0);
      return{platform:'tx',total,allPage:total?Math.ceil(total/l):0,results:songs.map((i:any)=>({
        id:String(i.id||''),name:(i.name||'')+(i.title_extra||''),
        singer:i.singer?.map((s:any)=>s.name).join('\u3001')||'',albumName:i.album?.name||'',
        interval:String(Math.floor((i.interval||0)/60))+':'+String((i.interval||0)%60).padStart(2,'0'),
        source:'tx',songmid:i.mid||i.file?.media_mid||'',img:i.album?.mid?`https://y.gtimg.cn/music/photo_new/T002R500x500M000${i.album.mid}.jpg`:''
      }))};
    }catch(e){console.error('[QQMusicSearch]',e);return{platform:'tx',total:0,allPage:0,results:[]};}
  }
}
class NeteaseSearchService {
  private static EAPI_KEY='e82ckenh8dichen8';
  async search(kw:string,p:number,l:number):Promise<SearchResult>{
    try{
      const url='/api/cloudsearch/pc';
      const text=JSON.stringify({s:kw,type:1,limit:l,total:p===1,offset:l*(p-1)});
      const message=`nobody${url}use${text}md5forencrypt`;
      const digest=await md5(message);
      const data=`${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
      const buf=new TextEncoder().encode(data);
      const padded=pkcs7Pad(buf);
      const encrypted=aesEcbEncryptPure(padded.buffer,NeteaseSearchService.EAPI_KEY);
      const params=toHex(encrypted);
      const r=await fetch('http://interface.music.163.com/eapi/batch',{method:'POST',headers:{'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36','Origin':'https://music.163.com','Referer':'https://music.163.com/','Content-Type':'application/x-www-form-urlencoded'},body:`params=${params}`});
      const d=await r.json();
      const songs=d.result?.songs||[];
      const total=Number(d.result?.songCount||0);
      return{platform:'wy',total,allPage:total?Math.ceil(total/l):0,results:songs.map((i:any)=>({
        id:String(i.id),name:i.name,singer:i.ar?.map((a:any)=>a.name).join('\u3001')||'',
        albumName:i.al?.name||'',interval:i.dt?Math.floor(i.dt/60000)+':'+String(Math.floor(i.dt/1000)%60).padStart(2,'0'):'00:00',
        source:'wy',songmid:String(i.id),img:i.al?.picUrl||''
     }))};
    }catch(e){console.error('[NeteaseSearch]',e);return{platform:'wy',total:0,allPage:0,results:[]};}
  }
}
class MiguSearchService {
  private static DEVICE_ID='963B7AA0D21511ED807EE5846EC87D20';
  private static SIGN_KEY='6cdc72a439cef99a3418d2a78aa28c73';
  async search(kw:string,p:number,l:number):Promise<SearchResult>{
    try{
      const time=Date.now().toString();
      const sign=await md5(`${kw}${MiguSearchService.SIGN_KEY}yyapp2d16148780a1dcc7408e06336b98cfd50${MiguSearchService.DEVICE_ID}${time}`);
      const searchSwitch=encodeURIComponent(JSON.stringify({song:1,album:0,singer:0,tagSong:1,mvSong:0,bestShow:1,songlist:0,lyricSong:0}));
      const url=`https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1&searchSwitch=${searchSwitch}&pageSize=${l}&text=${encodeURIComponent(kw)}&pageNo=${p}&sort=0&sid=USS`;
      const r=await fetch(url,{
        headers:{uiVersion:'A_music_3.6.1',deviceId:MiguSearchService.DEVICE_ID,timestamp:time,sign,channel:'0146921','User-Agent':'Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30'}
      });
      const d=await r.json();
      let results:any[]=[];
      const resultList=d.songResultData?.resultList||[];
      for(const group of resultList){
        for(const data of group){
          if(!data.songId||!data.copyrightId)continue;
          results.push({id:String(data.copyrightId),name:data.name,singer:data.singerList?.map((s:any)=>s.name).join('\u3001')||'',albumName:data.album||'',interval:data.duration||'00:00',source:'mg',copyrightId:String(data.copyrightId),img:(data.img3||data.img2||data.img1)?(/https?:/.test(data.img3||'')?(data.img3||data.img2||data.img1):`http://d.musicapp.migu.cn${data.img3||data.img2||data.img1}`)||'' :''});
          if(results.length>=l)break;
        }if(results.length>=l)break;
      }
      const total=Number(d.songResultData?.totalCount||d.totalCount||0);
      return{platform:'mg',total,allPage:total?Math.ceil(total/l):0,results};
    }catch(e){console.error('[MiguSearch]',e);return{platform:'mg',total:0,allPage:0,results:[]};}
  }
}
// ════════════════════════════════════════════════════
// 热搜服务 - 获取5大平台热搜关键词
// ════════════════════════════════════════════════════

export interface HotSearchItem {
  word: string;
  score: string;
  source: string;
}

export class HotSearchService {
  async getWyHotSearch(): Promise<HotSearchItem[]> {
    try {
      const r = await fetch('https://music.163.com/api/search/chart/detail?id=HOT_SEARCH_SONG%23%40%23');
      const d = await r.json() as any;
      const list = d?.data?.itemList || [];
      return list.slice(0, 10).map((item: any) => ({
        word: item.searchWord || '',
        score: item.score ? `${Math.floor(item.score / 10000)}万+` : '热门',
        source: 'wy'
      })).filter((item: HotSearchItem) => item.word);
    } catch (e) { console.error('[HotSearch][wy]', e); return []; }
  }

  async getTxHotSearch(): Promise<HotSearchItem[]> {
    try {
      const body = JSON.stringify({
        comm: { ct: '19', cv: '1803', guid: '0', patch: '118', uin: '0', wid: '0' },
        hotkey: { method: 'GetHotkeyForQQMusicPC', module: 'tencent_musicsoso_hotkey.HotkeyService', param: { search_id: '', uin: 0 } }
      });
      const r = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Referer': 'https://y.qq.com/portal/player.html' },
        body
      });
      const d = await r.json() as any;
      const list = d?.hotkey?.data?.vec_hotkey || [];
      return list.slice(0, 10).map((item: any) => ({
        word: item.query || '',
        score: item.score ? `${Math.floor(item.score / 10000)}万+` : '热门',
        source: 'tx'
      })).filter((item: HotSearchItem) => item.word);
    } catch (e) { console.error('[HotSearch][tx]', e); return []; }
  }

  async getKgHotSearch(): Promise<HotSearchItem[]> {
    try {
      const url = 'http://mobilecdnbj.kugou.com/api/v3/rank/song?version=9108&ranktype=2&plat=0&pagesize=20&area_code=1&page=1&volid=35050&rankid=6666&with_res_tag=1';
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const d = await r.json() as any;
      const info = d?.data?.info || [];
      return info.slice(0, 10).map((item: any) => {
        const parts = (item.filename || '').split(' - ');
        const songName = parts[1] || item.filename || '';
        return {
          word: songName,
          score: item.filesize ? `${Math.floor(item.filesize / 100000)}万+` : '热门',
          source: 'kg'
        };
      }).filter((item: HotSearchItem) => item.word);
    } catch (e) { console.error('[HotSearch][kg]', e); return []; }
  }

  async getKwHotSearch(): Promise<HotSearchItem[]> {
    try {
      const url = 'http://hotword.kuwo.cn/hotword.s?prod=kwplayer_ar_9.3.0.1&corp=kuwo&newver=2&vipver=9.3.0.1&source=kwplayer_ar_9.3.0.1_40.apk&p2p=1&notrace=0&uid=0&plat=kwplayer_ar&rformat=json&encoding=utf8&tabid=1';
      const r = await fetch(url, { headers: { 'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 9;)' } });
      const d = await r.json() as any;
      const list = d?.tagvalue || [];
      return list.slice(0, 10).map((item: any, index: number) => ({
        word: item.key || '',
        score: item.num ? `${Math.floor(item.num / 10000)}万+` : `Top ${index + 1}`,
        source: 'kw'
      })).filter((item: HotSearchItem) => item.word);
    } catch (e) { console.error('[HotSearch][kw]', e); return []; }
  }

  async getMgHotSearch(): Promise<HotSearchItem[]> {
    try {
      const r = await fetch('http://jadeite.migu.cn:7090/music_search/v3/search/hotword');
      const d = await r.json() as any;
      const list = d?.data?.hotwords?.[0]?.hotwordList || [];
      return list.filter((item: any) => item.resourceType === 'song').slice(0, 10).map((item: any, index: number) => ({
        word: item.word || '',
        score: item.searchCount ? `${Math.floor(item.searchCount / 10000)}万+` : `Top ${index + 1}`,
        source: 'mg'
      })).filter((item: HotSearchItem) => item.word);
    } catch (e) { console.error('[HotSearch][mg]', e); return []; }
  }

  async getAllHotSearch(): Promise<{ platforms: number; keywords: string[]; details: HotSearchItem[] }> {
    const results = await Promise.allSettled([
      this.getWyHotSearch(),
      this.getTxHotSearch(),
      this.getKgHotSearch(),
      this.getKwHotSearch(),
      this.getMgHotSearch()
    ]);

    const allItems: HotSearchItem[] = [];
    const keywordSet = new Set<string>();

    results.forEach(result => {
      if (result.status === 'fulfilled') {
        result.value.forEach(item => {
          allItems.push(item);
          keywordSet.add(item.word);
        });
      }
    });

    return {
      platforms: allItems.length > 0 ? new Set(allItems.map(i => i.source)).size : 0,
      keywords: Array.from(keywordSet),
      details: allItems
    };
  }
}

export class SearchService{
  private kw=new KuwoSearchService();private kg=new KugouSearchService();
  private tx=new QQMusicSearchService();private wy=new NeteaseSearchService();private mg=new MiguSearchService();
  async search(keyword:string,source?:string,page:number=1,limit:number=20):Promise<SearchResult[]>{
    if(!source)return Promise.all([this.kw.search(keyword,page,limit),this.kg.search(keyword,page,limit),this.tx.search(keyword,page,limit),this.wy.search(keyword,page,limit),this.mg.search(keyword,page,limit)]);
    switch(source){
      case 'kw':return[await this.kw.search(keyword,page,limit)];
      case 'kg':return[await this.kg.search(keyword,page,limit)];
      case 'tx':return[await this.tx.search(keyword,page,limit)];
      case 'wy':return[await this.wy.search(keyword,page,limit)];
      case 'mg':return[await this.mg.search(keyword,page,limit)];
      default:throw new Error('Unsupported source: '+source);
    }
  }
}
