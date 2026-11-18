window.__ModuleLoader__.load({
  id: 'dsh-tab-complete',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const turns = new Map();
    function diag(stage, detail = {}) {
      fetch('/api/dsh-tab-complete', {method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({mode:'diag',stage,...{detail}})}).catch(() => {});
    }
    function Prediction(props) {
      const {sessionId, useSession, useInput, inputActions} = props;
      const running = useSession(s => s.running);
      const lastMessageAt = useSession(s => {
        const nodes = s?.nodes;
        if (!Array.isArray(nodes)) return null;
        for (let i = nodes.length - 1; i >= 0; i--) {
          const node = nodes[i];
          if ((node.kind === 'assistant' || node.kind === 'user') && Number.isFinite(node.time) && node.time > 0) return node.time;
        }
        return null;
      });
      const draft = useInput(s => s.draft);
      const [text, setText] = React.useState('');
      const anchor = React.useRef(null);
      const live = React.useRef({text:'',draft:'',running:false});
      const asked = React.useRef('');
      const dismissed = React.useRef('');
      live.current = {text,draft,running};
      let turn = turns.get(sessionId);
      if (!turn) { turn = {running:false,epoch:0,asked:-1,text:''}; turns.set(sessionId,turn); }
      if (running && !turn.running) {turn.epoch++;turn.text='';}
      turn.running = running;
      React.useEffect(() => {
        const card = anchor.current?.closest('[data-composer-card]');
        if (!card) return;
        const region = [...document.querySelectorAll('[data-conversation-session]')]
          .find(el => el.getAttribute('data-conversation-session') === sessionId);
        const transcript = region?.querySelector('[data-conversation-scroll]') || region;
        if (!transcript) return;
        let timer, controller, disposed = false;
        function schedule() {
          const today = new Date().toDateString();
          if (turn.day && turn.day !== today) {
            turn.asked = -1;
            turn.text = '';
            dismissed.current = '';
            setText('');
          }
          turn.day = today;
          clearTimeout(timer);
          // Let the transcript render settle without a fixed idle delay.
          timer = setTimeout(async () => {
            const state = live.current;
            if (state.running || state.draft.trim()) return;
            const context = (transcript.innerText || '').trim().slice(-2000);
            if (!context || context === dismissed.current) return;
            if (turn.asked === turn.epoch) { setText(turn.text); return; }
            asked.current = context;
            turn.asked = turn.epoch;
            controller?.abort();
            controller = new AbortController();
            let suggestion = '';
            {
              try {
                const response = await fetch('/api/dsh-tab-complete', {
                  method:'POST', headers:{'Content-Type':'application/json'}, signal:controller.signal,
                  body:JSON.stringify({mode:'next-message',context,draft:'',sessionId,
                    timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,lastMessageAt})
                });
                const data = await response.json();
                suggestion = data.ok ? data.text || '' : '';
              } catch (error) {
                if (error.name !== 'AbortError') diag('prediction-failed',{name:error.name});
              }
            }
            if (!disposed && !live.current.running && !live.current.draft.trim()) {
              turn.text = suggestion;
              setText(suggestion);
              diag('slot-suggestion',{length:suggestion.length,model:true});
            }
          }, 0);
        }
        const observer = new MutationObserver(schedule);
        observer.observe(transcript,{childList:true,subtree:true,characterData:true});
        window.addEventListener('focus',schedule);
        document.addEventListener('visibilitychange',schedule);
        schedule();
        return () => {disposed=true; clearTimeout(timer); controller?.abort(); observer.disconnect();
          window.removeEventListener('focus',schedule);document.removeEventListener('visibilitychange',schedule);};
      }, [sessionId,running,draft,lastMessageAt]);
      React.useEffect(() => {
        if (running || draft.trim()) setText('');
      }, [running,draft]);
      React.useEffect(() => {
        function keydown(event) {
          const state = live.current;
          if (!state.text || state.running || state.draft.trim() || event.isComposing) return;
          const card = anchor.current?.closest('[data-composer-card]');
          const editor = card?.querySelector('[data-lexical-editor="true"]');
          if (!editor || !(event.target === editor || editor.contains(event.target))) return;
          if (event.key === 'Escape') {
            dismissed.current = asked.current;
            setText('');
            return;
          }
          if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
          const span = inputActions.captureInsertion();
          if (!inputActions.insertText(state.text, span)) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          diag('slot-accepted',{length:state.text.length});
          // Keep this turn cached so clearing an accepted draft restores it.
          setText('');
        }
        window.addEventListener('keydown',keydown,true);
        return () => window.removeEventListener('keydown',keydown,true);
      }, [sessionId,inputActions]);
      return h('span', {ref:anchor, 'data-dsh-tc-visible':text ? '' : undefined,
        'aria-hidden':true, style:{position:'absolute',top:12,left:14,right:12,pointerEvents:'none',
          color:'var(--dsw-alias-label-caption)',fontSize:'inherit',lineHeight:'24px',
          whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},
        text, text ? h('kbd',{style:{marginLeft:8,fontSize:10,border:'1px solid currentColor',borderRadius:3,padding:'0 3px'}},'Tab') : null);
    }
    return {
      inject:['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style=document.createElement('style');
          style.textContent='[data-composer-card]:has([data-dsh-tc-visible]) [data-composer-placeholder]{visibility:hidden!important}';
          document.head.append(style);
          return () => style.remove();
        });
        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name:'conversation.input.overlay',id:'dsh-tab-complete',key:'dsh-tab-complete',order:100,
        }, Prediction));
      },
    };
  },
});
