import { useId } from "react";

export function LilyScene({ className = "" }: { className?: string }) {
  const id = useId();
  const paint = (name: string) => `url(#${id}-${name})`;
  return (
    <svg
      className={className}
      viewBox="0 0 1000 620"
      fill="none"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <radialGradient id={`${id}-background`} cx=".63" cy=".38" r=".78">
          <stop stopColor="#982b42" />
          <stop offset=".48" stopColor="#541728" />
          <stop offset="1" stopColor="#210e18" />
        </radialGradient>
        <linearGradient
          id={`${id}-petal`}
          x1="0"
          y1="-260"
          x2="0"
          y2="15"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#fffaf2" />
          <stop offset=".38" stopColor="#f7e5de" />
          <stop offset=".75" stopColor="#df9daa" />
          <stop offset="1" stopColor="#a32b49" />
        </linearGradient>
        <linearGradient
          id={`${id}-back-petal`}
          x1="0"
          y1="-260"
          x2="0"
          y2="15"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#f7e7df" />
          <stop offset=".55" stopColor="#e8bdc2" />
          <stop offset="1" stopColor="#8f2942" />
        </linearGradient>
        <linearGradient id={`${id}-leaf`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#819075" />
          <stop offset="1" stopColor="#253a32" />
        </linearGradient>
        <radialGradient id={`${id}-heart`}>
          <stop stopColor="#6a1835" />
          <stop offset="1" stopColor="#a02b4800" />
        </radialGradient>
        <linearGradient id={`${id}-shade`} x1="0" y1="0" x2="0" y2="1">
          <stop offset=".6" stopColor="#1a0b1600" />
          <stop offset="1" stopColor="#1a0b16bb" />
        </linearGradient>
        <path
          id={`${id}-petal-shape`}
          d="M0 14C-42-22-90-88-83-147c4-39 25-77 47-113 4 36 33 63 46 91C36-113 30-45 0 14Z"
        />
        <g id={`${id}-flower`}>
          <g fill={paint("back-petal")} stroke="#efd0cc" strokeWidth=".6">
            <use
              href={`#${id}-petal-shape`}
              transform="rotate(60) scale(.78 .91)"
            />
            <use
              href={`#${id}-petal-shape`}
              transform="rotate(180) scale(.88 .93)"
            />
            <use
              href={`#${id}-petal-shape`}
              transform="rotate(300) scale(.78 .99)"
            />
          </g>
          <g fill={paint("petal")} stroke="#fff0e4" strokeWidth=".7">
            <use href={`#${id}-petal-shape`} transform="rotate(-6)" />
            <use
              href={`#${id}-petal-shape`}
              transform="rotate(119) scale(1.03 .96)"
            />
            <use
              href={`#${id}-petal-shape`}
              transform="rotate(239) scale(.95 1.04)"
            />
          </g>
          <g stroke="#c88f9d" strokeWidth="1.2" opacity=".55">
            <path d="M0 1C-15-53-41-117-32-219M-6-10c-26-51-49-100-46-145M4-12c5-48 4-88-11-135" />
            <path
              d="M0 1C-15-53-41-117-32-219M-6-10c-26-51-49-100-46-145M4-12c5-48 4-88-11-135"
              transform="rotate(120)"
            />
            <path
              d="M0 1C-15-53-41-117-32-219M-6-10c-26-51-49-100-46-145M4-12c5-48 4-88-11-135"
              transform="rotate(240)"
            />
          </g>
          <circle r="55" fill={paint("heart")} />
          <g fill="#91334a" opacity=".8">
            <ellipse cx="-19" cy="-53" rx="2" ry="3" />
            <ellipse cx="-29" cy="-68" rx="1.5" ry="3" />
            <ellipse cx="-9" cy="-73" rx="1.5" ry="2.5" />
            <ellipse cx="-38" cy="-44" rx="2" ry="3" />
            <ellipse cx="-24" cy="-91" rx="1.5" ry="2" />
            <ellipse cx="47" cy="9" rx="3" ry="2" />
            <ellipse cx="61" cy="22" rx="3" ry="1.5" />
            <ellipse cx="75" cy="8" rx="2" ry="1.5" />
            <ellipse cx="-27" cy="40" rx="2" ry="3" />
            <ellipse cx="-43" cy="56" rx="2" ry="3" />
            <ellipse cx="-51" cy="35" rx="2" ry="3" />
          </g>
          <g stroke="#e9c8a8" strokeWidth="2.2" strokeLinecap="round">
            <path d="M0 8Q-35-21-61-69M0 8Q-6-26-15-82M0 8Q29-20 44-66M0 8Q49-4 73-34M0 8Q-19 24-54 10" />
          </g>
          <g fill="#8c263c" stroke="#edb6a8" strokeWidth="1">
            <ellipse
              cx="-61"
              cy="-69"
              rx="4"
              ry="11"
              transform="rotate(-32 -61 -69)"
            />
            <ellipse
              cx="-15"
              cy="-82"
              rx="4"
              ry="11"
              transform="rotate(-9 -15 -82)"
            />
            <ellipse
              cx="44"
              cy="-66"
              rx="4"
              ry="10"
              transform="rotate(30 44 -66)"
            />
            <ellipse
              cx="73"
              cy="-34"
              rx="4"
              ry="10"
              transform="rotate(56 73 -34)"
            />
            <ellipse
              cx="-54"
              cy="10"
              rx="4"
              ry="9"
              transform="rotate(-70 -54 10)"
            />
          </g>
        </g>
      </defs>
      <path fill={paint("background")} d="M0 0h1000v620H0z" />
      <g opacity=".2" stroke="#dda6b2" strokeWidth=".8">
        <ellipse
          cx="566"
          cy="300"
          rx="376"
          ry="231"
          transform="rotate(-24 566 300)"
        />
        <ellipse
          cx="566"
          cy="300"
          rx="399"
          ry="253"
          transform="rotate(-24 566 300)"
        />
      </g>
      <g stroke="#7b886c" strokeWidth="5" strokeLinecap="round">
        <path d="M638 680Q645 446 608 262" />
        <path d="M642 662Q430 509 287 350" />
        <path d="M628 574Q778 437 810 313" strokeWidth="3" />
      </g>
      <g fill={paint("leaf")} stroke="#9a9c7c" strokeWidth=".6">
        <path d="M629 547C698 454 730 431 789 425 762 502 705 541 629 547Z" />
        <path d="M626 589C571 466 512 451 469 449 503 538 558 578 626 589Z" />
        <path d="M506 552C403 501 353 518 301 547 380 562 442 568 506 552Z" />
        <path d="M785 394C766 336 776 287 801 252 818 302 810 352 785 394Z" />
      </g>
      <g stroke="#bdc19a" strokeWidth=".9" opacity=".5">
        <path d="m639 541 131-102m-151 136-132-111M488 549l-164-4m464-168 11-109" />
      </g>
      <use
        href={`#${id}-flower`}
        transform="translate(287 350) rotate(-37) scale(.61)"
        opacity=".91"
      />
      <use
        href={`#${id}-flower`}
        transform="translate(605 266) rotate(17) scale(.86)"
      />
      <path fill={paint("shade")} d="M0 0h1000v620H0z" />
      <g fill="#f2c4c8" opacity=".4">
        <circle cx="142" cy="163" r="1.5" />
        <circle cx="865" cy="102" r="2" />
        <circle cx="904" cy="413" r="1" />
        <circle cx="417" cy="87" r="1.2" />
        <circle cx="112" cy="453" r="1" />
      </g>
    </svg>
  );
}
