const app = document.querySelector("#app");
const connection = document.querySelector("#connection");
const API = "/.netlify/functions/game";
const questionsCount = 3;
let room = null, playerId = sessionStorage.getItem("str_player_id") || crypto.randomUUID();
sessionStorage.setItem("str_player_id", playerId);
let name = sessionStorage.getItem("str_name") || "";
let currentCode = sessionStorage.getItem("str_room") || "";
let chosen = null, feedback = "", pollTimer = null, clockTimer = null, now = Date.now(), busy = false, lastSeenRound = null;
const h = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function api(action, data={}) {
  const res = await fetch(API, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,playerId,code:currentCode,...data})});
  const body = await res.json().catch(()=>({error:"Server returned an invalid response."}));
  if (!res.ok || !body.ok) throw new Error(body.error || "Request failed");
  return body;
}
function showError(msg, target="message") { const el=document.getElementById(target); if(el) el.innerHTML=`<div class="error">${h(msg)}</div>`; }
function startPolling() { clearInterval(pollTimer); pollTimer=setInterval(refresh,1200); refresh(); }
async function refresh() {
  if(!currentCode || busy) return;
  try {
    const data=await api("state");
    const nextRoom=data.room;
    if (nextRoom.status === "playing" && nextRoom.round !== lastSeenRound) {
      chosen = null;
      feedback = "";
      lastSeenRound = nextRoom.round;
    }
    if (nextRoom.status === "lobby") { chosen = null; feedback = ""; lastSeenRound = null; }
    room=nextRoom; connection.textContent="LIVE · SYNCED"; render();
  }
  catch(e){ connection.textContent="RECONNECTING"; if(!room) showError(e.message); }
}
function home() {
  clearInterval(pollTimer); room=null; currentCode=""; sessionStorage.removeItem("str_room");
  app.innerHTML=`<section class="hero"><div class="eyebrow">REAL-TIME MULTIPLAYER</div><h1>Think fast.<br><span>Score big.</span></h1><p class="muted">Challenge your friends from different devices. Join with a room code, answer before the clock runs out, and race to the top.</p></section>
  <section class="card"><div class="label">ENTER THE ARENA · 01 / PLAY</div><label>Player name</label><input id="name" maxlength="20" placeholder="e.g. QuizMaster" value="${h(name)}"><button id="create" class="primary wide">＋ Create a room</button><div class="or">OR JOIN FRIENDS</div><label>Room code</label><input id="code" maxlength="5" placeholder="ABCDE" value=""><button id="join" class="secondary wide">Join room ↗</button><div id="message"></div><p class="smallnote">Rules: 2–8 players · 3 questions · 15 seconds each. Correct answers earn 100 points plus up to 50 speed points. Wrong or unanswered questions earn zero.</p></section>
  <section class="rules"><article><b>01</b><h3>Gather your crew</h3><p>Create a room and share its code with friends.</p></article><article><b>02</b><h3>Think quickly</h3><p>Answer each question before the timer reaches zero.</p></article><article><b>03</b><h3>Race to win</h3><p>Earn points and see who tops the leaderboard.</p></article></section>`;
  document.getElementById("create").onclick=()=>enter("create");
  document.getElementById("join").onclick=()=>enter("join");
}
async function enter(action) {
  name=document.getElementById("name").value.trim();
  if(!name){showError("Please enter your player name.");return;}
  sessionStorage.setItem("str_name",name);
  currentCode=action==="join"?document.getElementById("code").value.trim().toUpperCase():"";
  if(action==="join" && currentCode.length!==5){showError("Enter the 5-character room code.");return;}
  busy=true;
  try {
    const data=await api(action,{name});
    currentCode=data.room.code; sessionStorage.setItem("str_room",currentCode);
    room=data.room; chosen=null; feedback=""; lastSeenRound=null;
    render(); startPolling();
  } catch(e){showError(e.message);}
  finally{busy=false;}
}
async function act(action,data={}) {
  if(busy)return; busy=true;
  try { const result=await api(action,data); if(result.room)room=result.room; render(); }
  catch(e){feedback=e.message;render();}
  finally{busy=false;}
}
function render(){
  if(!room)return home();
  const sorted=[...room.players].sort((a,b)=>b.score-a.score);
  const players=room.players.map(p=>`<div class="player"><span>${h(p.name)} ${p.id===room.hostId?"👑":""}</span><small>${p.answered?"Answered":"Ready"} · ${p.score} pts</small></div>`).join("");
  if(room.status==="lobby"){
    app.innerHTML=`<div class="roomhead"><div><div class="label">ROOM CODE</div><button class="roomcode" id="copy">${h(room.code)} <small> · COPY</small></button></div><span class="pill">${room.players.length}/8 PLAYERS</span></div><section class="panel"><div class="label">YOUR PLAYERS</div><div class="players">${players}</div><div id="message"></div>${room.hostId===playerId?`<button class="primary wide" id="start" ${room.players.length<2?"disabled":""}>Start race ↗</button>`:"<p class='muted'>Waiting for the host to start the race…</p>"}<button class="secondary wide" id="leave">Leave room</button></section>`;
    document.getElementById("copy").onclick=()=>navigator.clipboard.writeText(room.code).then(()=>{document.getElementById("copy").innerHTML="COPIED ✓";});
    if(document.getElementById("start"))document.getElementById("start").onclick=()=>act("start");
    document.getElementById("leave").onclick=home; return;
  }
  if(room.status==="playing"){
    const q=room.question;
    if(!q){app.innerHTML="<div class='panel'>Loading question…</div>";return;}
    const remaining=Math.max(0,Math.ceil((q.endsAt-Date.now())/1000));
    app.innerHTML=`<div class="roomhead"><div><div class="label">ROOM · ${h(room.code)}</div><div class="pill">ROUND ${q.index+1} / ${room.questionCount}</div></div><div class="timer" id="timer">${String(remaining).padStart(2,"0")}s</div></div><section class="panel"><div class="label">${h(q.category)} · QUESTION ${q.index+1}</div><div class="progress"><span style="width:${remaining/15*100}%"></span></div><h2 class="question">${h(q.q)}</h2><div class="options">${q.options.map((o,i)=>`<button class="option ${chosen===i?"selected":""}" data-answer="${i}" ${chosen!==null?"disabled":""}>${h(o)}</button>`).join("")}</div><div id="message">${feedback? `<div class="notice">${h(feedback)}</div>`:""}</div><div class="players">${players}</div></section>`;
    document.querySelectorAll("[data-answer]").forEach(b=>b.onclick=()=>{chosen=Number(b.dataset.answer);feedback="Answer submitted";render();act("answer",{answer:chosen});});
    clearInterval(clockTimer); clockTimer=setInterval(()=>{const t=document.getElementById("timer");if(!t)return;const n=Math.max(0,Math.ceil((q.endsAt-Date.now())/1000));t.textContent=String(n).padStart(2,"0")+"s";if(n===0)refresh();},200);
    return;
  }
  if(room.status==="between"){
    app.innerHTML=`<section class="panel winner"><div class="trophy">⚡</div><div class="label">ROUND ${room.round+1} COMPLETE</div><h2>${h(room.lastResult?.correctText||"Round complete")}</h2><p class="muted">Correct answer</p><div class="players">${players}</div></section>`;
    return;
  }
  clearInterval(clockTimer);
  app.innerHTML=`<section class="panel winner"><div class="trophy">🏆</div><div class="label">RACE COMPLETE</div><h2>${h(sorted[0]?.name||"Winner")} wins!</h2><div class="leaderboard">${sorted.map((p,i)=>`<div class="rank"><strong>#${i+1}</strong><span>${h(p.name)}</span><b>${p.score} pts</b></div>`).join("")}</div><button class="primary wide" id="again">Back to home</button></section>`;
  document.getElementById("again").onclick=home;
}
home();
if(currentCode) startPolling();
