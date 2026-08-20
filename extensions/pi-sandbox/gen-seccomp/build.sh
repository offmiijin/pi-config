#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# build.sh — artefatos portáteis do pi-sandbox
#
# Gera:
#   1. ../landlock-exec-<arch>   — helper Landlock da arquitetura (x86_64,
#      aarch64, riscv64...). O runtime escolhe por process.arch.
#   2. ../seccomp.bpf            — filtro seccomp UNIVERSAL: um único BPF
#      cobre x86_64 + aarch64 + riscv64 (libseccomp resolve os números de
#      syscall de cada arquitetura). NÃO é específico da máquina.
#
# Uso:
#   ./build.sh                          # nativo (arch atual)
#   TARGET=aarch64-unknown-linux-gnu ./build.sh   # cross-compile
#
# Cross-compile requer:
#   rustup target add aarch64-unknown-linux-gnu
#   aarch64-linux-gnu-gcc (binutils cross) + libseccomp para o alvo
#   (ex: pacote aarch64-linux-gnu-libseccomp no Arch)
#
# O filtro seccomp é SEMPRE gerado pelo binário nativo (o BPF é
# multi-arquitetura por construção) — TARGET não afeta o seccomp.bpf.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")"

# ── Triplet da arquitetura alvo ───────────────────────────────────────
HOST_TRIPLET="$(rustc -vV | sed -n 's/^host: //p')"
case "${HOST_TRIPLET}" in
  x86_64*) TRIPLET=x86_64 ;;
  aarch64*) TRIPLET=aarch64 ;;
  riscv64*) TRIPLET=riscv64 ;;
  *) TRIPLET="${HOST_TRIPLET%%-*}" ;;
esac

# ── 1. landlock-exec ──────────────────────────────────────────────────
if [ -n "${TARGET:-}" ]; then
  echo "▶ Compilando landlock-exec para ${TARGET} (cross)..."
  cargo build --release --target "${TARGET}"
  BIN="target/${TARGET}/release/landlock-exec"
  case "${TARGET}" in
    x86_64*) TRIPLET=x86_64 ;;
    aarch64*) TRIPLET=aarch64 ;;
    riscv64*) TRIPLET=riscv64 ;;
    *) TRIPLET="${TARGET%%-*}" ;;
  esac
else
  echo "▶ Compilando landlock-exec (${TRIPLET}, nativo)..."
  cargo build --release
  BIN="target/release/landlock-exec"
fi

cp "${BIN}" "../landlock-exec-${TRIPLET}"
chmod +x "../landlock-exec-${TRIPLET}"
echo "✓ ../landlock-exec-${TRIPLET}"

# ── 2. seccomp.bpf universal ──────────────────────────────────────────
echo "▶ Gerando seccomp.bpf (multi-arch: x86_64 + aarch64 + riscv64)..."
cargo build --release --bin gen-seccomp
cargo run --release --bin gen-seccomp > ../seccomp.bpf
echo "✓ ../seccomp.bpf ($(wc -c < ../seccomp.bpf) bytes)"
