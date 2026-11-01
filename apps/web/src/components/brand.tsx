import Link from "next/link";

export function Brand() {
  return (
    <Link href="/" className="brand" aria-label="Duet home">
      <svg aria-hidden="true" viewBox="0 0 36 36">
        <path
          d="M18 23C10 18 12 8 18 3c6 5 8 15 0 20Zm0 0C8 26 3 17 3 10c8 0 15 5 15 13Zm0 0c10 3 15-6 15-13-8 0-15 5-15 13Z"
          fill="currentColor"
        />
        <path
          d="M18 18v14m0-7-6-6m6 6 6-6"
          stroke="var(--bg)"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
      <span>
        duet<span className="brand-period">.</span>
      </span>
    </Link>
  );
}
