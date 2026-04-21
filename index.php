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
        font-size: 16px;
      }
      .airline {
        color: #888;
        font-size: 12px;
      }

    </style>
  </head>
  <body>
    <h2>LIVE FEED</h2>
    <div id="container">
      <?php if ($error): ?>
        <div style="color:#666"><?= htmlspecialchars($error) ?></div>
      <?php elseif (empty($flights)): ?>
        <div style="color:#666">Searching skies...</div>
      <?php else: ?>
        <?php foreach ($flights as $f): ?>
          <div class="flight-row">
            <div>
              <div class="route"><?= htmlspecialchars($f['origin']) ?> ➔ <?= htmlspecialchars($f['destination']) ?></div>
              <div class="airline"><?= htmlspecialchars($f['airline']) ?> · <?= htmlspecialchars($f['callsign']) ?><?= !empty($f['registration']) ? ' · ' . htmlspecialchars($f['registration']) : '' ?></div>
            </div>
          </div>
        <?php endforeach; ?>
      <?php endif; ?>
    </div>
  </body>
</html>
