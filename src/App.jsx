import { useState, useRef, useEffect } from 'react'
import './App.css'

// ── Constants ──────────────────────────────────────────────────────────────
const COLORS = [
  { bg: '#c8f562', tx: '#0c0c0c' }, { bg: '#f5c842', tx: '#0c0c0c' },
  { bg: '#f562a4', tx: '#0c0c0c' }, { bg: '#62c8f5', tx: '#0c0c0c' },
  { bg: '#a462f5', tx: '#f0f0f0' }, { bg: '#f5a462', tx: '#0c0c0c' },
  { bg: '#62f5b0', tx: '#0c0c0c' }, { bg: '#ff6b6b', tx: '#0c0c0c' },
]
const col = i => COLORS[i % COLORS.length]
const fmt = n => '$' + (parseFloat(n) || 0).toFixed(2)
const lsGet = (key, def) => { try { return JSON.parse(localStorage.getItem(key)) ?? def } catch { return def } }

// Seed uid counter above any persisted ids to avoid collisions on reload
let _uid = (() => {
  const p = lsGet('pmb_people', [])
  const r = lsGet('pmb_receiptItems', [])
  return Math.max(0, ...p.flatMap(x => [x.id, ...x.items.map(i => i.id)]), ...r.map(x => x.id))
})()
const uid = () => ++_uid

const SCAN_PROMPT = `Analyze this receipt and return ONLY a raw JSON object — no markdown, no explanation.
{"items":[{"name":"string","price":number}],"tax":number|null,"tip":number|null,"total":number|null}
Rules: items = food/drink lines only (no subtotal/tax/tip/total rows); if qty N at price P, list N entries each at price P; all prices as plain numbers.`

// ── App ────────────────────────────────────────────────────────────────────
export default function App() {
  const [people, setPeople]             = useState(() => lsGet('pmb_people', []))
  const [receiptItems, setReceiptItems] = useState(() => lsGet('pmb_receiptItems', []))
  const [taxRate, setTaxRate]           = useState(() => lsGet('pmb_taxRate', '10.25'))
  const [tipAmount, setTipAmount]       = useState(() => lsGet('pmb_tipAmount', ''))
  const [tipPct, setTipPct]             = useState(() => lsGet('pmb_tipPct', ''))
  const [tipMode, setTipMode]           = useState(() => lsGet('pmb_tipMode', null))
  const [receipt, setReceipt]           = useState(null)
  const [scanning, setScanning]         = useState(false)
  const [scanStatus, setScanStatus]     = useState('No receipt loaded')
  const [taxWarn, setTaxWarn]           = useState(false)
  const [tipWarn, setTipWarn]           = useState(false)
  const dragId = useRef(null)

  // ── Auto-save ──
  useEffect(() => { localStorage.setItem('pmb_people',       JSON.stringify(people))       }, [people])
  useEffect(() => { localStorage.setItem('pmb_receiptItems', JSON.stringify(receiptItems)) }, [receiptItems])
  useEffect(() => { localStorage.setItem('pmb_taxRate',      JSON.stringify(taxRate))      }, [taxRate])
  useEffect(() => { localStorage.setItem('pmb_tipAmount',    JSON.stringify(tipAmount))    }, [tipAmount])
  useEffect(() => { localStorage.setItem('pmb_tipPct',       JSON.stringify(tipPct))       }, [tipPct])
  useEffect(() => { localStorage.setItem('pmb_tipMode',      JSON.stringify(tipMode))      }, [tipMode])

  // ── Derived totals ──
  const subtotal = people.reduce((s, p) => s + p.items.reduce((a, i) => a + (parseFloat(i.price) || 0), 0), 0)
  const tip      = tipMode === 'pct' ? subtotal * (parseFloat(tipPct) || 0) / 100 : parseFloat(tipAmount) || 0
  const tax      = subtotal * (parseFloat(taxRate) || 0) / 100
  const total    = subtotal + tax + tip

  // ── People mutations ──
  const mut = fn => setPeople(prev => fn(prev))
  const addPerson    = (name = '', items = []) =>
    mut(ps => [...ps, { id: uid(), name, items: items.map(i => ({ ...i, id: uid() })), open: true }])
  const removePerson = id => {
    setReceiptItems(prev => prev.map(r => r.assignedTo === id ? { ...r, assignedTo: null, linkedItemId: null } : r))
    mut(ps => ps.filter(p => p.id !== id))
  }
  const patchPerson = (id, patch) => mut(ps => ps.map(p => p.id === id ? { ...p, ...patch } : p))
  const addItem     = pid => mut(ps => ps.map(p => p.id === pid
    ? { ...p, open: true, items: [...p.items, { id: uid(), name: '', price: '' }] } : p))
  const removeItem  = (pid, iid) => {
    setReceiptItems(prev => prev.map(r => r.linkedItemId === iid ? { ...r, assignedTo: null, linkedItemId: null } : r))
    mut(ps => ps.map(p => p.id === pid ? { ...p, items: p.items.filter(i => i.id !== iid) } : p))
  }
  const patchItem   = (pid, iid, patch) => mut(ps => ps.map(p => p.id === pid
    ? { ...p, items: p.items.map(i => i.id === iid ? { ...i, ...patch } : i) } : p))

  // ── Clear all ──
  const clearAll = () => {
    setPeople([]); setReceiptItems([]); setTaxRate('10.25')
    setTipAmount(''); setTipPct(''); setTipMode(null)
    setReceipt(null); setScanStatus('No receipt loaded')
    setTaxWarn(false); setTipWarn(false)
  }

  // ── Load a saved group of people (re-assigns fresh ids) ──
  const loadSave = savedPeople => {
    setPeople(savedPeople.map(p => ({
      ...p, id: uid(), open: true,
      items: p.items.map(i => ({ ...i, id: uid() })),
    })))
  }

  // ── File handling ──
  const handleFile = f => {
    if (!f) return
    setScanStatus(f.name.length > 22 ? f.name.slice(0, 22) + '…' : f.name)
    const r = new FileReader()
    r.onload = e => setReceipt({ base64: e.target.result.split(',')[1], mediaType: f.type || 'image/jpeg', dataUrl: e.target.result })
    r.readAsDataURL(f)
  }

  // ── Scan receipt via Claude ──
  const scanReceipt = async () => {
    if (!receipt) return
    setScanning(true); setTaxWarn(false); setTipWarn(false)
    try {
      const block = receipt.mediaType.startsWith('image/')
        ? { type: 'image',    source: { type: 'base64', media_type: receipt.mediaType, data: receipt.base64 } }
        : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: receipt.base64 } }

      const res = await fetch('/api/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1500,
          messages: [{ role: 'user', content: [block, { type: 'text', text: SCAN_PROMPT }] }],
        }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error.message)

      const parsed = JSON.parse(data.content.map(c => c.text || '').join('').replace(/```json|```/g, '').trim())
      const items = (parsed.items || []).map(it => ({
        id: uid(), name: it.name, price: parseFloat(it.price) || 0, assignedTo: null, linkedItemId: null,
      }))
      setReceiptItems(items)

      if (parsed.tax != null) {
        const s = (parsed.items || []).reduce((a, i) => a + (parseFloat(i.price) || 0), 0)
        s > 0 ? setTaxRate((parsed.tax / s * 100).toFixed(2)) : setTaxWarn(true)
      } else setTaxWarn(true)

      if (parsed.tip != null) { setTipMode('dollar'); setTipAmount(parseFloat(parsed.tip).toFixed(2)); setTipPct('') }
      else setTipWarn(true)

      setScanStatus(`${items.length} items ✓`)
    } catch (e) {
      console.error(e); setScanStatus('Scan failed — try again')
    }
    setScanning(false)
  }

  // ── Drag & drop ──
  const onDrop = pid => {
    const rid = dragId.current
    if (rid == null) return
    const ri = receiptItems.find(r => r.id === rid)
    if (!ri || ri.assignedTo != null) { dragId.current = null; return }
    const newIid = uid()
    setReceiptItems(prev => prev.map(r => r.id === rid ? { ...r, assignedTo: pid, linkedItemId: newIid } : r))
    mut(ps => ps.map(p => p.id === pid
      ? { ...p, open: true, items: [...p.items, { id: newIid, name: ri.name, price: ri.price.toString() }] } : p))
    dragId.current = null
  }

  // ── Render ──
  return (
    <>
      <header>
        <h1>PAY ME BACK</h1>
        <div className="header-actions">
          <button className="btn-ghost btn-danger" onClick={clearAll}>✕ Clear</button>
        </div>
      </header>

      <div className="app">
        {/* Left column */}
        <div>
          <div className="panel-label">Bill Settings</div>
          <div className="settings-row">
            <SettingCard label="Tax Rate" suffix="%" warn={taxWarn} warnTip="Couldn't parse tax — enter manually">
              <input type="number" value={taxRate} step="0.01" min="0" max="100"
                onChange={e => { setTaxRate(e.target.value); setTaxWarn(false) }} />
            </SettingCard>
            <SettingCard label="Tip $" prefix="$" warn={tipWarn} warnTip="Couldn't parse tip — enter manually">
              <input type="number" value={tipAmount} placeholder="0.00" step="0.01" min="0"
                onChange={e => { setTipAmount(e.target.value); setTipPct(''); setTipMode('dollar'); setTipWarn(false) }} />
            </SettingCard>
            <SettingCard label="Tip %" suffix="%">
              <input type="number" value={tipPct} placeholder="—" step="1" min="0" max="100"
                onChange={e => { setTipPct(e.target.value); setTipAmount(''); setTipMode('pct') }} />
            </SettingCard>
          </div>

          <div className="panel-label">People & Orders</div>
          {people.length === 0 && (
            <div className="people-empty">
              <div className="big">👥</div>
              <p>No people yet.<br />Add someone below or scan a receipt first.</p>
            </div>
          )}
          <div className="people-list">
            {people.map((p, idx) => (
              <PersonCard key={p.id} person={p} idx={idx}
                onToggle={() => patchPerson(p.id, { open: !p.open })}
                onName={name => patchPerson(p.id, { name })}
                onAddItem={() => addItem(p.id)}
                onRemove={() => removePerson(p.id)}
                onItemChange={(iid, patch) => patchItem(p.id, iid, patch)}
                onItemRemove={iid => removeItem(p.id, iid)}
                onDrop={() => onDrop(p.id)}
              />
            ))}
          </div>
          <button className="add-person-btn" onClick={() => addPerson()}>
            <PlusIcon /> Add Person
          </button>
        </div>

        {/* Right sidebar */}
        <div className="sidebar">
          <SavesPanel people={people} onLoad={loadSave} />
          <ReceiptPanel receipt={receipt} scanning={scanning} status={scanStatus}
            items={receiptItems} dragId={dragId} onFile={handleFile} onScan={scanReceipt} />
          <Breakdown people={people} subtotal={subtotal} taxPct={parseFloat(taxRate) || 0} tip={tip} total={total} />
        </div>
      </div>
    </>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

function SavesPanel({ people, onLoad }) {
  const [saves, setSaves] = useState(() => lsGet('pmb_saves', {}))
  const [name, setName]   = useState('')

  const persist = updated => {
    setSaves(updated)
    localStorage.setItem('pmb_saves', JSON.stringify(updated))
  }

  const save = () => {
    const key = name.trim()
    if (!key) return
    persist({ ...saves, [key]: { people, savedAt: new Date().toISOString() } })
    setName('')
  }

  const del = key => {
    const updated = { ...saves }
    delete updated[key]
    persist(updated)
  }

  const keys = Object.keys(saves)

  return (
    <div className="saves-panel">
      <div className="saves-header"><h3>SAVED GROUPS</h3></div>
      <div className="saves-input-row">
        <input className="saves-name-input" type="text" placeholder="Name this group…"
          value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && save()} />
        <button className="saves-save-btn" onClick={save} disabled={!name.trim()}>Save</button>
      </div>
      {keys.length === 0
        ? <div className="saves-empty">No saved groups yet</div>
        : keys.map(k => (
          <div key={k} className="save-row">
            <span className="save-name">{k}</span>
            <button className="save-load-btn" onClick={() => onLoad(saves[k].people)}>Load</button>
            <button className="save-del-btn" onClick={() => del(k)}><XIcon /></button>
          </div>
        ))
      }
    </div>
  )
}

function SettingCard({ label, prefix, suffix, warn, warnTip, children }) {
  return (
    <div className={`setting-card${warn ? ' warn-field' : ''}`}>
      <label>
        <span>{label}</span>
        {warn && <WarnIcon tip={warnTip} />}
      </label>
      <div className="iw">
        {prefix && <span className="pfx">{prefix}</span>}
        {children}
        {suffix && <span className="pfx">{suffix}</span>}
      </div>
    </div>
  )
}

function WarnIcon({ tip }) {
  return <span className="warn-icon">!<span className="tooltip">{tip}</span></span>
}

function PersonCard({ person: p, idx, onToggle, onName, onAddItem, onRemove, onItemChange, onItemRemove, onDrop }) {
  const [dragOver, setDragOver] = useState(false)
  const c = col(idx)
  const psub = p.items.reduce((s, i) => s + (parseFloat(i.price) || 0), 0)

  return (
    <div className={`person-card${dragOver ? ' drag-over' : ''}`}
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false) }}
      onDrop={() => { setDragOver(false); onDrop() }}>

      <div className="person-header">
        <div className="avatar" style={{ background: c.bg, color: c.tx }}>
          {p.name ? p.name[0].toUpperCase() : idx + 1}
        </div>
        <input className="name-input" type="text" placeholder="Name" value={p.name}
          onChange={e => onName(e.target.value)} />
        <div className="person-total-tag">{psub > 0 ? fmt(psub) : ''}</div>
        <button className={`chevron${p.open ? ' open' : ''}`} onClick={onToggle}><ChevronIcon /></button>
      </div>

      {p.open && (
        <div className="items-section">
          {p.items.length > 0 && (
            <div className="items-header-row"><span>Item</span><span>Price</span><span /></div>
          )}
          {p.items.length === 0 && (
            <div className="empty-items">No items — add one or drag from receipt</div>
          )}
          {p.items.map(it => (
            <div key={it.id} className="item-row">
              <input className="item-name-input" type="text" placeholder="Item name…" value={it.name}
                onChange={e => onItemChange(it.id, { name: e.target.value })} />
              <input className="item-price-input" type="number" min="0" step="0.01" placeholder="0.00" value={it.price}
                onChange={e => onItemChange(it.id, { price: e.target.value })} />
              <button className="item-del" onClick={() => onItemRemove(it.id)}><XIcon /></button>
            </div>
          ))}
          <div className="items-footer">
            <button className="add-item-btn" onClick={onAddItem}>+ Add item</button>
            <button className="remove-person-btn" onClick={onRemove}>✕ Remove</button>
          </div>
        </div>
      )}
    </div>
  )
}

function ReceiptPanel({ receipt, scanning, status, items, dragId, onFile, onScan }) {
  const [dragover, setDragover] = useState(false)
  return (
    <div className="receipt-panel">
      <div className="receipt-panel-header">
        <h3>RECEIPT SCAN</h3>
        <div className="receipt-status">{status}</div>
      </div>
      <div className={`upload-zone${dragover ? ' dragover' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragover(true) }}
        onDragLeave={() => setDragover(false)}
        onDrop={e => { e.preventDefault(); setDragover(false); onFile(e.dataTransfer.files[0]) }}>
        <input type="file" accept="image/*,.pdf" onChange={e => onFile(e.target.files[0])} />
        <div className="upload-icon">🧾</div>
        <div className="upload-text"><strong>Drop receipt here</strong>or click · JPG, PNG, PDF</div>
      </div>
      {receipt && (
        <div className="receipt-preview">
          {receipt.mediaType.startsWith('image/') && <img src={receipt.dataUrl} alt="Receipt preview" />}
          <button className={`scan-btn${scanning ? ' scanning' : ''}`} disabled={scanning} onClick={onScan}>
            {scanning
              ? <><span className="dot">.</span><span className="dot">.</span><span className="dot">.</span> Reading receipt…</>
              : <><ScanIcon /> Scan with AI</>}
          </button>
        </div>
      )}
      <div className="unassigned-section">
        <h4>Scanned Items — drag onto a person</h4>
        <div className="unassigned-list">
          {items.length === 0
            ? <div className="unassigned-empty">Scan a receipt to see items here</div>
            : items.map(ri => (
              <div key={ri.id} className={`receipt-item${ri.assignedTo != null ? ' assigned' : ''}`}
                draggable={ri.assignedTo == null}
                onDragStart={() => { dragId.current = ri.id }}
                onDragEnd={() => {}}>
                <span className="ri-drag">⠿</span>
                <span className="ri-name">{ri.name}</span>
                <span className="ri-price">{fmt(ri.price)}</span>
              </div>
            ))
          }
        </div>
        {items.length > 0 && <div className="drag-hint">☝️ Drag items onto a person's card to assign them</div>}
      </div>
    </div>
  )
}

function Breakdown({ people, subtotal, taxPct, tip, total }) {
  const tax = subtotal * taxPct / 100
  return (
    <div className="breakdown-card">
      <div className="breakdown-header">
        <h3>BREAKDOWN</h3>
        <div className="grand-badge">Total: <span>{fmt(total)}</span></div>
      </div>
      {subtotal > 0 && (
        <div className="prop-bar">
          {people.map((p, i) => {
            const psub = p.items.reduce((s, it) => s + (parseFloat(it.price) || 0), 0)
            return (
              <div key={p.id} className="prop-seg"
                style={{ width: `${psub / subtotal * 100}%`, background: col(i).bg, minWidth: psub > 0 ? '4px' : 0 }} />
            )
          })}
        </div>
      )}
      <div>
        {people.length === 0 || subtotal === 0
          ? <div className="breakdown-empty">Add people &amp; items to see totals</div>
          : people.map((p, i) => {
            const psub = p.items.reduce((s, it) => s + (parseFloat(it.price) || 0), 0)
            const prop = subtotal > 0 ? psub / subtotal : 0
            const c = col(i)
            const nm = p.name || '—'
            return (
              <div key={p.id} className="breakdown-row">
                <div className="br-left">
                  <div className="mini-av" style={{ background: c.bg, color: c.tx }}>
                    {nm !== '—' ? nm[0].toUpperCase() : '?'}
                  </div>
                  <div>
                    <div className="br-name">{nm}</div>
                    <div className="br-detail">{fmt(psub)} + {fmt(prop * tax)} tax + {fmt(prop * tip)} tip</div>
                  </div>
                </div>
                <div className="br-right">{fmt(psub + prop * tax + prop * tip)}</div>
              </div>
            )
          })
        }
      </div>
    </div>
  )
}

// ── Icons ──────────────────────────────────────────────────────────────────
const PlusIcon    = () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
const ChevronIcon = () => <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
const XIcon       = () => <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M1.5 1.5l8 8M9.5 1.5l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
const ScanIcon    = () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 4V2a1 1 0 011-1h2M10 1h2a1 1 0 011 1v2M13 10v2a1 1 0 01-1 1h-2M4 13H2a1 1 0 01-1-1v-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M4 7h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
