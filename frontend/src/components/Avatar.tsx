/**
 * @fileoverview Avatar — photo if available else initials circle.
 */

import styles from "./Avatar.module.scss";

interface Props {
  first_name?: string;
  last_name?: string;
  email?: string;
  src?: string | null;
  size?: number;
}

/** Initials from first/last or email fallback. */
function initials(
  first_name?: string,
  last_name?: string,
  email?: string,
): string {
  const fn = (first_name || "").trim();
  const ln = (last_name || "").trim();
  
  if (fn && ln) return `${fn[0]}${ln[0]}`.toUpperCase();
  if (fn) return fn.slice(0, 2).toUpperCase();
  if (email) return email.slice(0, 2).toUpperCase();
  return "•";
}

/**
 * Avatar with photo or initials fallback.
 */
export function Avatar({
  first_name,
  last_name,
  email,
  src,
  size = 32,
}: Props) {
  if (src) {
    return (
      <img
        src={src}
        alt="Profile"
        width={size}
        height={size}
        className={styles["avatar-img"]}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={styles["avatar-fallback"]}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initials(first_name, last_name, email)}
    </span>
  );
}
