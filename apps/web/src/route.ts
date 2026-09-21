export const routes = [
  { href: '/', label: 'Current case', view: 'case' },
  { href: '/profile', label: 'Profile', view: 'profile' },
  { href: '/leaderboard', label: 'Daily ledger', view: 'leaderboard' },
] as const

export type AppView = (typeof routes)[number]['view']

export function viewFromPath(pathname: string): AppView {
  return routes.find(({ href }) => href === pathname)?.view ?? 'case'
}
