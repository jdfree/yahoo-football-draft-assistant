// Pull every relevant player with projections ALREADY SCORED under league 813836's
// custom rules, then rank by VORP. Run via claude-in-chrome javascript_tool on any
// football.fantasysports.yahoo.com page (needs the user's logged-in session).
// Yahoo's "Pre-Season" rank (rk) is NOT league-adjusted — the gap between proj and
// rk is where the value is.
const base='https://football.fantasysports.yahoo.com/f1/813836/players?status=ALL&stat1=S_PS_2026&sort=PTS';
const plan={QB:50,RB:75,WR:75,TE:50,K:25,DEF:25};
const out=[];
for(const [pos,n] of Object.entries(plan)){
  for(let off=0; off<n; off+=25){
    const html=await fetch(`${base}&pos=${pos}&count=${off}`,{credentials:'include'}).then(r=>r.text());
    const doc=new DOMParser().parseFromString(html,'text/html');
    for(const tr of doc.querySelectorAll('table tbody tr')){
      const td=[...tr.querySelectorAll('td')].map(x=>x.innerText.trim().replace(/\s+/g,' '));
      if(td.length<10) continue;
      const blob=td[2];
      const m=blob.match(/^(.+?)(?:Video Forecast|No new player Notes|Player Note)/);
      const nm=(m?m[1]:blob.split(/\s{2,}/)[0]).replace(/(Q|IR|O|D|SUSP|PUP-P|NA)$/,'').trim();
      const tm=(blob.match(/\b([A-Za-z]{2,4}) - (QB|RB|WR|TE|K|DEF)\b/)||[])[1]||'';
      out.push({n:nm,p:pos,t:tm,bye:+td[5]||0,proj:+td[6]||0,rk:+td[7]||9999});
    }
  }
}
// Replacement level for 12 teams, slots QB/WR/WR/RB/RB/TE/FLEX/K/DEF
const repl={QB:13,RB:30,WR:36,TE:13,K:13,DEF:13};
const by=p=>out.filter(x=>x.p===p).sort((a,c)=>c.proj-a.proj);
const R={}; for(const[p,i]of Object.entries(repl)){const l=by(p); R[p]=l[Math.min(i-1,l.length-1)].proj;}
out.forEach(x=>x.v=+(x.proj-R[x.p]).toFixed(1));
window.__board=out;                      // keep for follow-up slices
window.__taken=window.__taken||new Set(); // names already drafted
JSON.stringify({replacement:R,n:out.length});
