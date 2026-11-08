# Deploying OneLink Intake on Vultr

OneLink Intake is a single Node.js process with an embedded SQLite database. It
needs no external services: OCR runs on the same machine.

## Server

- Vultr Cloud Compute, plan `vc2-1c-2gb` (1 vCPU, 2 GB RAM): about $0.014/hour,
  capped at $10/month. Ubuntu 24.04 LTS.
- Charges accrue while the instance exists, including when stopped. Destroying
  the instance ends all charges; do not enable snapshots, backups, reserved IPs
  or block storage unless you want them to keep billing after teardown.

## Setup

```sh
# on the instance
sudo apt-get update && sudo apt-get install -y nodejs npm git
git clone https://github.com/adarsh6980/onelink.git
cd onelink
# system deps for the OCR engines: tesseract-ocr, python3 + rapidocr-onnxruntime
sudo apt-get install -y tesseract-ocr python3 python3-pip
pip3 install rapidocr-onnxruntime
```

## Run

```sh
node server.js   # serves on :8123
```

For a durable setup, wrap `node server.js` in a systemd unit and put Caddy (or
nginx + certbot) in front for TLS. Restrict the firewall to 80/443/SSH.

## Data

- Uploads live under `data/files/`; SQLite lives under `data/`.
- Expired links delete their files automatically. No external storage is used.

## Teardown

Destroy the instance from the Vultr console or API (`DELETE /v2/instances/{id}`).
With no snapshots, backups, reserved IPs or block storage attached, destruction
stops all billing for this deployment.
