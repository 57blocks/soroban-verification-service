const HEX = "0123456789abcdef";

const isHex = (char: string) => HEX.includes(char);

export const maskHex = (target: string) =>
  [...target].map((char) => (isHex(char) ? "·" : char)).join("");

export const scrambleFrame = (
  target: string,
  progress: number,
  random: () => number = Math.random,
) => {
  if (progress >= 1) return target;
  const chars = [...target];
  const settled = Math.floor(
    Math.max(0, progress) * chars.filter(isHex).length,
  );
  let seen = 0;
  return chars
    .map((char) => {
      if (!isHex(char)) return char;
      seen += 1;
      return seen <= settled
        ? char
        : HEX.charAt(Math.floor(random() * HEX.length));
    })
    .join("");
};
