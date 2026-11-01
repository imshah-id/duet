import Link from "next/link";
export default function NotFound() {
  return (
    <main className="centered-page">
      <h1>Room not found.</h1>
      <p>Check your invite link or make a new room.</p>
      <Link className="button button-primary" href="/">
        Back to Duet
      </Link>
    </main>
  );
}
