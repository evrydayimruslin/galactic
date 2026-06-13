// Interface Demo — reference Agent for the Interfaces convention
// (ultralight-spec/conventions/interfaces.md). Functions are deliberately
// dependency-free (no storage/net permissions) so the demo works on any
// account out of the box.

export function get_greeting(args: { name?: string }) {
  const name = (args?.name || "world").toString().slice(0, 64);
  return {
    greeting: `Hello, ${name}!`,
    served_at: new Date().toISOString(),
  };
}

export function roll_dice(args: { count?: number; sides?: number }) {
  const count = Math.min(10, Math.max(1, Math.floor(args?.count ?? 2)));
  const sides = Math.min(100, Math.max(2, Math.floor(args?.sides ?? 6)));
  const rolls = Array.from(
    { length: count },
    () => 1 + Math.floor(Math.random() * sides),
  );
  return {
    rolls,
    total: rolls.reduce((sum, roll) => sum + roll, 0),
    spec: `${count}d${sides}`,
  };
}
