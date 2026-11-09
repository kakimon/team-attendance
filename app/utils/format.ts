const WD = ['日', '月', '火', '水', '木', '金', '土']
export function formatDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`
}
export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return `${formatDate(iso)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
