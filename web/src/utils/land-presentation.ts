// Levels are game state. Only levels 1–5 currently have extracted soil sprites.
// Blue crystal uses a distinct tint over neutral soil, rather than a purple sprite.
export function getLandPresentation(land: any) {
  const rawLevel = Number(land?.level)
  const level = Number.isSafeInteger(rawLevel) && rawLevel > 0 ? rawLevel : 1
  const names: Record<number, string> = { 1: '普通土地', 2: '红土地', 3: '黑土地', 4: '金土地', 5: '紫土地', 6: '蓝晶土地' }
  const locked = land?.status === 'locked'
  const spriteLevel = level <= 5 ? level : 1
  const snow = !!(land?.isSnow || land?.snow || land?.snowy || String(land?.weather || '').toLowerCase() === 'snow')
  const sprite = locked ? `land_locked${snow ? '_snow' : ''}`
    : Number(land?.plantSize) > 1 ? `land_valid${spriteLevel}_2x2`
      : `land_${land?.needWater ? 'dry' : 'valid'}${spriteLevel}${spriteLevel === 1 && snow ? '_snow' : ''}`
  return { level, label: locked ? '未解锁土地' : `${names[level] || '未知土地'} · ${level}级`,
    textureUrl: `/game-config/land_images/${sprite}.png`,
    rotate: !locked && level === 5,
    filter: !locked && level === 6 ? 'sepia(1) saturate(4) hue-rotate(150deg) brightness(1.1)' : 'none',
    className: locked ? 'land-level-locked' : level <= 6 ? `land-level-${level}` : 'land-level-unknown' }
}
