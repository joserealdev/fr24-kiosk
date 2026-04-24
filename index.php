<?php
$api_url = "http://localhost:7000/api/flights";

$ch = curl_init($api_url);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 5,
]);
$response = curl_exec($ch);
curl_close($ch);

$result  = $response !== false ? json_decode($response, true) : null;
$flights = $result['flights'] ?? [];
$error   = $result['error'] ?? ($result === null ? 'Wait for API...' : null);
?>
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="refresh" content="10" />
    <style>
      body {
        background: #000;
        color: #fbaf00;
        font-family: "Courier New", monospace;
        margin: 0;
        padding: 10px;
        overflow: hidden;
      }
      h2 {
        font-size: 18px;
        border-bottom: 1px solid #444;
        margin: 0 0 10px 0;
        color: #fff;
      }
      .flight-row {
        display: flex;
        justify-content: space-between;
        padding: 8px 0;
        border-bottom: 1px solid #222;
      }
      .route {
        color: #fff;
        font-weight: bold;
        font-size: 24px;
      }
      .airline {
        color: #888;
        font-size: 18px;
      }
      .airline-logo {
        height: 36px;
        width: auto;
        max-width: 15%;
        object-fit: contain;
        margin-left: 12px;
        align-self: center;
        background-color: #fff;
      }

      @keyframes scrollUp {
        0%   { transform: translateY(0); }
        100% { transform: translateY(-50%); }
      }
      .scroll-wrap {
        overflow: hidden;
      }
      .scroll-inner.scrolling {
        animation: scrollUp var(--scroll-duration, 10s) linear infinite;
      }

    </style>
  </head>
  <body>
    <h2>LIVE FEED</h2>
    <div id="container" class="scroll-wrap">
      <?php if ($error): ?>
        <div style="color:#666"><?= htmlspecialchars($error) ?></div>
      <?php elseif (empty($flights)): ?>
        <div style="color:#666">Searching skies...</div>
      <?php else: ?>
        <div class="scroll-inner <?= count($flights) > 4 ? 'scrolling' : '' ?>" id="scrollInner">
        <?php
          // Duplicate rows for seamless looping when scrolling
          $rows = $flights;
          if (count($flights) > 4) $rows = array_merge($flights, $flights);
        ?>
        <?php foreach ($rows as $f): ?>
          <div class="flight-row">
            <div>
              <div class="route"><?= htmlspecialchars($f['origin']) ?> ➔ <?= htmlspecialchars($f['destination']) ?></div>
              <div class="airline"><?= htmlspecialchars($f['airline']) ?> · <?= htmlspecialchars($f['callsign']) ?><?= !empty($f['registration']) ? ' · ' . htmlspecialchars($f['registration']) : '' ?><?= !empty($f['model']) ? ' · ' . htmlspecialchars($f['model']) : '' ?></div>
            </div>
            <?php if (!empty($f['logo'])): ?>
              <img src="<?= htmlspecialchars($f['logo']) ?>" alt="" class="airline-logo" />
            <?php endif; ?>
          </div>
        <?php endforeach; ?>
        </div>
      <?php endif; ?>
    </div>
    <?php if (!$error && count($flights) > 4): ?>
    <script>
      // Set scroll duration based on number of flights (~3s per flight)
      const count = <?= count($flights) ?>;
      document.getElementById('scrollInner').style.setProperty(
        '--scroll-duration', (count * 3) + 's'
      );
    </script>
    <?php endif; ?>
  </body>
</html>
