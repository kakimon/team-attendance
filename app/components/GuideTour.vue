<script setup lang="ts">
// 操作ガイドツアーの実行役（チーム画面の TeamShell に 1 つ）。
// - 自分からは始めない：端末に「実行中」と保存されているときだけ動く（開始は案内カード / 使い方）
// - 画面移動は［次へ］［戻る］［続ける］を押したときだけ。入力途中のフォームがあれば移動しない
// - 遷移先が描画されてから、許可リストの目印（data-guide）で表示中の要素だけを強調。無ければ説明だけ
// - ボタンを代わりに押さない・保存しない。Driver.js は実行時にだけ読み込む
import type { Driver } from 'driver.js'
import type { TeamSnapshot } from '~/utils/types'
import { GUIDE_TARGETS, canRunTour, chooseReturnFocus, chooseTarget, onPage, pageLocation, tourContext, tourLength, tourStep, validStep, type GuideTarget, type TourKind, type TourView } from '~/utils/tour'
import { SNOOZE_MS, getTeamGuide, guideRevision, setTour, type TourStatus } from '~/utils/guideStore'

const props = defineProps<{ snap: TeamSnapshot; token: string }>()
const { user } = useAuth()
const route = useRoute()
const router = useRouter()

const active = computed<{ kind: TourKind; step: number } | null>(() => {
  void guideRevision.value
  if (!user.value) return null
  for (const kind of ['admin', 'parent'] as const) {
    const t = getTeamGuide(user.value.id, props.snap.team.id, kind).tour
    // Saved state is re-checked against the current role and step range: if it does not fit, do nothing.
    if (t?.status === 'active' && canRunTour(kind, props.snap.me.role) && validStep(kind, t.step)) return { kind, step: t.step }
  }
  return null
})
const view = computed<TourView | null>(() => (active.value ? tourStep(active.value.kind, active.value.step, tourContext(props.snap)) : null))
const here = computed(() => !!view.value && onPage(props.token, view.value.page, route.path, route.query))
const total = computed(() => (active.value ? tourLength(active.value.kind) : 0))

// ---- unsaved form input (never navigate away from it) ----
const initial = new Map<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, string>()
function onFocusIn(e: FocusEvent) {
  const el = e.target
  if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) && el.form && !initial.has(el)) initial.set(el, el.value)
}
const onSubmit = () => initial.clear()
/** ← / → move between steps while the guide is shown (driver.js only does this for its own step lists). */
function onKeyUp(e: KeyboardEvent) {
  if (!showing.value || e.defaultPrevented || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return
  const t = e.target as HTMLElement | null
  if (t?.closest('input, textarea, select, [contenteditable], [role="tablist"], [role="slider"], [role="radiogroup"]')) return
  if (e.key === 'ArrowRight' && active.value && active.value.step >= total.value - 1) return // finishing needs the 完了 button
  void go(e.key === 'ArrowRight' ? 1 : -1)
}
function hasUnsavedInput() {
  for (const [el, v] of initial) if (el.isConnected && el.value !== v) return true
  return false
}
watch(() => route.fullPath, () => initial.clear())

// ---- driver.js (loaded on first use only) ----
let d: Driver | null = null
let closingByUs = false
let run = 0 // cancels an older wait when the step changes
let origin: { el: Element | null; y: number } | null = null
let lastTarget: HTMLElement | null = null
const loadError = ref(false)
const showing = ref(false)
const moving = ref(false) // our own navigation in progress: no "paused" chip flash
const notice = ref('')

function quietDestroy() {
  if (!d) return
  closingByUs = true
  try { d.destroy() } catch { /* already gone */ }
  closingByUs = false
  d = null
  showing.value = false
}

function measure(el: HTMLElement) {
  const r = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  const visible = el.isConnected && r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
    && !el.closest('[hidden],[inert],[aria-hidden="true"]')
  const disabled = (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true' || !!el.closest('fieldset:disabled')
  return { visible, disabled, text: el.textContent ?? '' }
}
function findTarget(name: GuideTarget): HTMLElement | null {
  if (!Object.hasOwn(GUIDE_TARGETS, name)) return null // allow-list only
  const els = [...document.querySelectorAll<HTMLElement>(`[data-guide="${name}"]`)]
  const i = chooseTarget(els.map(measure))
  return i < 0 ? null : els[i]!
}
/** Wait (briefly, bounded) for the element: data may still be rendering. */
async function waitFor(name: GuideTarget, my: number): Promise<HTMLElement | null> {
  for (let i = 0; i < 20; i++) {
    if (my !== run) return null
    const el = findTarget(name)
    if (el) return el
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

async function show() {
  const my = ++run
  const a = active.value
  const v = view.value
  if (!a || !v || !here.value) return
  await nextTick()
  await new Promise((r) => requestAnimationFrame(() => r(null)))
  const el = v.target ? await waitFor(v.target, my) : null
  lastTarget = el
  if (my !== run) return
  let driverFn: typeof import('driver.js').driver
  try {
    const [m] = await Promise.all([import('driver.js'), import('driver.js/dist/driver.css')])
    driverFn = m.driver
  } catch {
    loadError.value = true
    return
  }
  if (my !== run || !active.value) return
  if (!origin) origin = { el: document.activeElement, y: window.scrollY }
  quietDestroy()
  const last = a.step === total.value - 1
  const interactive = !!(el && v.target && GUIDE_TARGETS[v.target].interactive)
  d = driverFn({
    animate: !reduced(),
    smoothScroll: !reduced(),
    allowClose: true,
    overlayClickBehavior: 'none',
    allowKeyboardControl: true,
    stagePadding: 6,
    stageRadius: 14,
    popoverClass: 'minna-tour',
    disableActiveInteraction: !interactive,
    // The team tabs stay usable: moving to another screen pauses the guide.
    allowedElements: () => [...document.querySelectorAll('nav[aria-label="チームメニュー"]')],
    showButtons: a.step === 0 ? ['next', 'close'] : ['previous', 'next', 'close'],
    nextBtnText: last ? '完了' : '次へ',
    prevBtnText: '戻る',
    doneBtnText: '完了',
    closeBtnLabel: 'ガイドを終了',
    onNextClick: () => { void go(1) },
    onPrevClick: () => { void go(-1) },
    onCloseClick: () => finish('skipped'),
    onDestroyStarted: () => { if (!closingByUs) finish('skipped') }, // Esc
    onPopoverRender: (p) => {
      p.progress.textContent = `${a.step + 1} / ${total.value}`
      p.progress.style.display = 'block'
      p.progress.setAttribute('aria-label', `全${total.value}ステップ中 ${a.step + 1}`)
      const row = document.createElement('div')
      row.className = 'minna-tour-extra'
      for (const [label, fn] of [['あとで', later], ['スキップ', () => finish('skipped')]] as const) {
        const b = document.createElement('button')
        b.type = 'button'
        b.textContent = label
        b.addEventListener('click', fn)
        row.appendChild(b)
      }
      p.wrapper.appendChild(row)
      if (notice.value) {
        const n = document.createElement('p')
        n.className = 'minna-tour-notice'
        n.setAttribute('role', 'alert')
        n.textContent = notice.value
        p.description.after(n)
      }
    },
  })
  d.highlight({
    ...(el ? { element: el } : {}),
    popover: {
      title: v.title, description: v.text, nextBtnText: last ? '完了' : '次へ', prevBtnText: '戻る',
      // Phones: above the element, so the bottom tab bar stays visible (falls back below if no room).
      ...(el && !matchMedia('(min-width: 768px)').matches ? { side: 'top' as const, align: 'center' as const } : {}),
      showButtons: a.step === 0 ? ['next', 'close'] : ['previous', 'next', 'close'],
    },
  })
  showing.value = true
  requestAnimationFrame(() => requestAnimationFrame(keepTabsVisible))
}
// driver.js re-places the popover on scroll / resize: check again afterwards.
const onViewport = () => { if (showing.value) requestAnimationFrame(() => requestAnimationFrame(keepTabsVisible)) }
/** Never cover the bottom tab bar (phones): lift the popover above it if it overlaps. */
function keepTabsVisible() {
  const pop = document.querySelector<HTMLElement>('.driver-popover.minna-tour')
  const nav = [...document.querySelectorAll<HTMLElement>('nav[aria-label="チームメニュー"]')].find((n) => n.getBoundingClientRect().height > 0 && getComputedStyle(n).position === 'fixed')
  if (!pop || !nav) return
  const p = pop.getBoundingClientRect()
  const top = nav.getBoundingClientRect().top
  if (p.bottom > top - 4) pop.style.top = `${Math.max(8, top - p.height - 8)}px`
}

function save(status: TourStatus, step: number, extra: { snoozeUntil?: number } = {}) {
  if (user.value && active.value) setTour(user.value.id, props.snap.team.id, active.value.kind, { status, step, ...extra })
}

async function go(delta: number) {
  const a = active.value
  if (!a) return
  const next = a.step + delta
  if (next < 0) return
  if (next >= total.value) return finish('done')
  const nv = tourStep(a.kind, next, tourContext(props.snap))!
  notice.value = ''
  if (!onPage(props.token, nv.page, route.path, route.query)) {
    if (hasUnsavedInput()) {
      notice.value = '入力中の内容があります。保存するか入力を元に戻してから、もう一度押してください。'
      d?.refresh()
      void show()
      return
    }
    moving.value = true
    quietDestroy()
    save('active', next)
    try { await router.push(pageLocation(props.token, nv.page)) } finally { moving.value = false }
  } else {
    save('active', next)
  }
}

const inView = (el: Element) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight && r.height > 0 }
/** Focus an element that is not focusable by itself only for this moment (tabindex removed on blur). */
function focusSoft(el: HTMLElement) {
  if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) {
    el.setAttribute('tabindex', '-1')
    // Removed once focus has really left (a blur followed by re-focus, e.g. by the closing popover, keeps it).
    const off = () => setTimeout(() => {
      if (document.activeElement !== el) { el.removeAttribute('tabindex'); el.removeEventListener('blur', off) }
    }, 0)
    el.addEventListener('blur', off)
  }
  el.focus({ preventScroll: true })
}
function restore() {
  const o = origin
  const last = lastTarget
  origin = null
  lastTarget = null
  nextTick(() => {
    const originEl = o?.el instanceof HTMLElement && o.el !== document.body ? o.el : null
    const heading = [...document.querySelectorAll<HTMLElement>('main h2')].find(inView) ?? null
    const title = document.querySelector<HTMLElement>('header h1')
    const cands = [
      { kind: 'origin' as const, el: originEl },
      { kind: 'last' as const, el: last },
      { kind: 'heading' as const, el: heading },
      { kind: 'title' as const, el: title },
    ].filter((c): c is { kind: typeof c.kind; el: HTMLElement } => !!c.el)
    const i = chooseReturnFocus(cands.map((c) => ({ kind: c.kind, connected: c.el.isConnected, inView: inView(c.el) })))
    if (i < 0) return
    const pick = cands[i]!
    focusSoft(pick.el)
    if (pick.kind === 'origin' && o) window.scrollTo({ top: o.y })
  })
}
function finish(status: 'done' | 'skipped') {
  const a = active.value
  quietDestroy()
  run++
  if (a) save(status, a.step)
  notice.value = ''
  restore()
}
function later() {
  const a = active.value
  quietDestroy()
  run++
  if (a) save('later', a.step, { snoozeUntil: Date.now() + SNOOZE_MS })
  restore()
}
const pausedNote = computed(() => (active.value && !here.value && !moving.value && !loadError.value
  ? `操作ガイドを一時停止しました（${active.value.step + 1} / ${total.value}）。画面下の［続ける］で再開、［終了］で終わります。` : ''))
// Filled a moment after the (always present) live region is on the page, so screen readers announce it.
const liveText = ref('')
let liveTimer: ReturnType<typeof setTimeout> | undefined
watch(pausedNote, (v) => {
  clearTimeout(liveTimer)
  liveText.value = ''
  if (v) liveTimer = setTimeout(() => { liveText.value = v }, 300)
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(liveTimer))
/** Paused (the person went to another screen): continue where the guide is. */
const chipNote = ref('')
async function resume() {
  if (!view.value) return
  if (hasUnsavedInput()) { chipNote.value = '入力中の内容があります。保存してから［続ける］を押してください。'; return }
  chipNote.value = ''
  await router.push(pageLocation(props.token, view.value.page))
}

watch(() => [active.value?.kind, active.value?.step, here.value, view.value?.target, view.value?.title], () => {
  if (active.value && here.value) void show()
  else { run++; quietDestroy() }
})
onMounted(() => {
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('submit', onSubmit, true)
  document.addEventListener('keyup', onKeyUp)
  window.addEventListener('scroll', onViewport, { passive: true })
  window.addEventListener('resize', onViewport)
  if (active.value && here.value) void show()
})
onBeforeUnmount(() => {
  run++
  quietDestroy()
  document.removeEventListener('focusin', onFocusIn, true)
  document.removeEventListener('submit', onSubmit, true)
  document.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('scroll', onViewport)
  window.removeEventListener('resize', onViewport)
})
</script>

<template>
  <p class="sr-only" aria-live="polite">{{ liveText }}</p>
  <div v-if="active && (!here || loadError) && !moving" role="region" aria-label="操作ガイド"
    class="fixed inset-x-3 bottom-20 z-30 mx-auto max-w-md rounded-box border border-base-300 bg-base-100 p-3 shadow-soft md:bottom-6">
    <p class="text-sm font-bold">操作ガイド {{ active.step + 1 }} / {{ total }}<span v-if="view" class="font-normal text-base-content/65">：{{ view.title }}</span></p>
    <p v-if="loadError" class="mt-1 text-xs text-error">ガイドを読み込めませんでした。通信状態を確認してください。</p>
    <p v-else class="mt-1 text-xs text-base-content/65">別の画面を開いたため、ガイドを止めています。</p>
    <p v-if="chipNote" role="alert" class="mt-1 text-xs text-error">{{ chipNote }}</p>
    <div class="mt-2 flex justify-end gap-2">
      <button type="button" class="btn btn-ghost btn-sm min-h-11" @click="finish('skipped')">終了</button>
      <button v-if="!loadError" type="button" class="btn btn-brand btn-sm min-h-11" @click="resume">続ける</button>
    </div>
  </div>
</template>
