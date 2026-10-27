/**
 * Links from outside (heyda://…, from a web page or a message) never open a screen directly.
 * Heyda. uses no such links itself, and a crafted one could land a set-up account in places it
 * should only reach on purpose, such as onboarding or the SOS screen. The app just opens.
 */
export function redirectSystemPath({ initial }: { path: string; initial: boolean }): string | null {
  return initial ? '/' : null;
}
