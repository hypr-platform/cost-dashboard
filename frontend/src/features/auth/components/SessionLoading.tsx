/**
 * Full-screen auth loading state. Renders the HYPR brand mark drawing itself
 * letter-by-letter, then radar rings pulse out from behind the logo while the
 * session is being validated.
 */
export function SessionLoading({ message }: { message: string }) {
  return (
    <main className="authContainer">
      <section className="authPanel panel sessionLoadingPanel">
        <div className="sessionLoadingStage" aria-hidden="true">
          <MapLoadingMark />
        </div>
        <p className="sessionLoadingMessage" role="status" aria-live="polite">
          {message}
        </p>
      </section>
    </main>
  );
}

/**
 * Branded loading mark.
 *
 * 1. Entrance (~1.1s): each HYPR letter path draws itself via
 *    stroke-dasharray / stroke-dashoffset, staggered left → right. Once
 *    the outline finishes, the fill fades in.
 * 2. Sustained: three radar rings pulse outward on a 2.4s loop.
 *
 * All animation lives in auth.css under `.map-loading-mark*`.
 */
function MapLoadingMark() {
  return (
    <div className="map-loading-mark" aria-hidden="true">
      <span className="map-loading-mark__pulse">
        <span className="map-loading-mark__ring" />
        <span className="map-loading-mark__ring" />
        <span className="map-loading-mark__ring" />
      </span>

      <svg
        className="map-loading-mark__logo"
        viewBox="0 0 8021 1423"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Hypr"
      >
        <path d="M7948.37 511.866L7529.3 514.172C7489.28 514.364 7456.49 482.469 7456.29 443.079L7454.15 74.3597C7453.95 34.9706 7486.35 2.69085 7526.37 2.4987L7945.64 0.000863573C7985.65 -0.191278 8018.44 31.7042 8018.64 71.0933L8020.78 440.005C8020.98 479.394 7988.58 511.674 7948.56 511.866M7541.98 429.63L7934.9 427.516L7932.95 84.351L7540.03 86.4646L7541.98 429.63Z" />
        <path d="M1114.53 675.763L125.312 681.143L121.799 42.6566L0 43.4252L7.8076 1423L129.606 1422.23L126.093 795.083L1115.12 789.703L1118.63 1416.85L1240.43 1416.28L1232.62 36.7002L1110.83 37.2766L1114.53 675.763Z" />
        <path d="M4939.5 147.782C4897.53 107.048 4845.41 74.96 4784.52 52.0952C4723.81 29.4225 4653.74 18.0861 4575.86 18.4704L3832.96 22.5054L3840.77 1402.27L3962.57 1401.7L3959.84 928.453L4578.79 925.187C4737.67 924.226 4860.44 882.147 4943.99 800.103C5027.53 717.866 5069.49 606.616 5068.71 469.427C5068.32 406.404 5057.2 346.84 5035.33 292.272C5013.47 237.32 4981.07 188.9 4939.3 148.166M4946.91 469.619C4947.5 567.995 4916.66 650.232 4855.37 714.215C4794.28 777.814 4700.78 810.478 4577.22 811.055L3959.25 814.321L3955.35 135.485L4573.32 132.218C4635.2 131.834 4690.24 141.057 4736.89 159.31C4783.15 177.564 4822.19 202.542 4852.83 233.285C4883.48 264.22 4906.9 300.342 4922.71 340.884C4938.52 381.618 4946.72 425.042 4947.11 469.619" />
        <path d="M6637.39 898.116C6722.89 878.902 6793.35 842.395 6847.03 789.556C6930.57 707.32 6972.53 596.07 6971.75 458.88C6971.36 395.858 6960.24 336.294 6938.38 281.726C6916.51 226.773 6884.11 178.354 6842.34 137.62C6800.38 96.8856 6748.26 64.7979 6687.36 41.9331C6626.66 19.2604 6556.58 7.924 6478.7 8.30828L5735.81 12.3433L5743.62 1392.11L5865.42 1391.54L5862.68 918.291L6481.63 915.025C6489.44 915.025 6497.05 914.833 6504.66 914.64L6867.91 1386.16L7013.52 1385.39L6637.2 898.5L6637.39 898.116ZM6849.95 459.265C6850.54 557.641 6819.7 639.878 6758.41 703.861C6697.32 767.46 6603.82 800.124 6480.26 800.7L5862.29 803.967L5858.39 125.13L6476.36 121.864C6538.24 121.48 6593.28 130.703 6639.93 148.956C6686.19 167.209 6725.23 191.996 6755.87 222.931C6786.52 253.865 6809.94 289.988 6825.75 330.53C6841.56 371.264 6849.76 414.688 6850.15 459.265" />
        <path d="M2573.4 815.826L2081.52 40.7263L2076.06 32.0799L1937.28 32.8485L2506.26 923.425L2202.93 1411.08L2337.03 1410.31L3197.81 25.7393L3063.72 26.5078L2573.4 815.826Z" />
      </svg>
    </div>
  );
}
