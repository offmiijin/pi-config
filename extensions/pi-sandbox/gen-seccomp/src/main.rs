/// gen-seccomp — Gera filtro seccomp BPF para o pi-sandbox.
///
/// Lê nomes de syscalls (um por linha ou como argumentos) e gera um
/// filtro BPF compilado via libseccomp. O filtro usa default-allow:
/// tudo é permitido exceto as syscalls explicitamente listadas.
///
/// Uso:
///   gen-seccomp bpf mount ptrace > seccomp.bpf
///   gen-seccomp --stdin < syscalls.txt > seccomp.bpf
///   gen-seccomp --list        # lista todas as syscalls bloqueáveis
///
/// O binário foi projetado para ser chamado uma vez durante o setup
/// da extensão pi-sandbox. O BPF gerado (~200 bytes) é carregado
/// em runtime pelo bwrap-executor.ts.

use libseccomp::*;
use std::env;
use std::io::{self, BufRead};
use std::process;

/// Syscalls bloqueadas por padrão. Nenhuma delas é necessária para
/// operações normais de um agente de desenvolvimento (file I/O, exec,
/// rede, sincronização).
const DEFAULT_BLOCKED: &[&str] = &[
    // ── eBPF / tracing (maiores vetores de 0-days) ──
    "bpf",
    "perf_event_open",
    // ── Debug / cross-process ──
    "ptrace",
    "process_vm_readv",
    "process_vm_writev",
    // ── Kernel modules ──
    "init_module",
    "finit_module",
    "delete_module",
    // ── Boot / kexec ──
    "kexec_load",
    "kexec_file_load",
    "reboot",
    // ── Filesystem ──
    "mount",
    "umount2",
    "pivot_root",
    "swapon",
    "swapoff",
    // ── Hardware ──
    "iopl",
    "ioperm",
    // ── System clock / hostname ──
    "settimeofday",
    "clock_settime",
    "adjtimex",
    "setdomainname",
    "sethostname",
    // ── Kernel keyring ──
    "add_key",
    "keyctl",
    // ── Outros vetores ──
    "userfaultfd",
    "kcmp",
    "lookup_dcookie",
    "_sysctl",
    "vhangup",
    "uselib",
    "acct",
    "modify_ldt",
];

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    // ── --list: exibe syscalls bloqueáveis ──
    if args.iter().any(|a| a == "--list" || a == "-l") {
        print_syscall_list();
        return;
    }

    // ── Coleta nomes de syscalls ──
    let syscall_names = if args.iter().any(|a| a == "--stdin") {
        read_syscalls_from_stdin()
    } else if args.is_empty() {
        // Sem argumentos: usa defaults
        DEFAULT_BLOCKED.iter().map(|s| s.to_string()).collect()
    } else {
        args
    };

    if syscall_names.is_empty() {
        eprintln!("gen-seccomp: nenhuma syscall fornecida.");
        eprintln!("Uso: gen-seccomp [--stdin] <syscall1> <syscall2> ...");
        eprintln!("     gen-seccomp --list");
        process::exit(1);
    }

    // ── Constrói filtro e escreve BPF no stdout ──
    if let Err(e) = build_filter(&syscall_names) {
        eprintln!("gen-seccomp: erro ao gerar filtro: {e}");
        process::exit(1);
    }
}

/// Constrói o filtro seccomp e escreve o bytecode BPF diretamente no stdout.
fn build_filter(syscall_names: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    // Filtro com default ALLOW — só bloqueia o que está explicitado
    let mut filter = ScmpFilterContext::new_filter(ScmpAction::Allow)?;

    // Arquiteturas suportadas (números de syscall variam por arquitetura).
    // Um único filtro cobre x86_64, aarch64 e riscv64: libseccomp resolve
    // cada syscall pelo número correto de cada arquitetura (as regras são
    // traduzidas automaticamente; syscalls inexistentes numa arch viram no-op).
    // A arquitetura nativa já está presente por padrão.
    for arch in [ScmpArch::X8664, ScmpArch::Aarch64, ScmpArch::Riscv64] {
        if !filter.is_arch_present(arch)? {
            filter.add_arch(arch)?;
        }
    }

    // Ação para arquitetura não reconhecida: matar processo
    filter.set_act_badarch(ScmpAction::KillProcess)?;

    // Adiciona regra de bloqueio para cada syscall
    let mut blocked = 0u32;
    let mut not_found = 0u32;

    for name in syscall_names {
        let name = name.trim();
        if name.is_empty() || name.starts_with('#') {
            continue;
        }

        match ScmpSyscall::from_name(name) {
            Ok(syscall) => {
                filter.add_rule(ScmpAction::KillProcess, syscall)?;
                blocked += 1;
            }
            Err(_) => {
                eprintln!("gen-seccomp: aviso — syscall '{name}' não encontrada na tabela de syscalls");
                not_found += 1;
            }
        }
    }

    if blocked == 0 {
        return Err("nenhuma syscall válida foi reconhecida".into());
    }

    // Otimização binary tree (nível 2)
    let _ = filter.set_ctl_optimize(2);

    // Exporta BPF diretamente para stdout
    // export_bpf escreve o bytecode compilado no file descriptor
    let mut stdout = io::stdout();
    filter.export_bpf(&mut stdout)?;

    eprintln!(
        "gen-seccomp: {blocked} syscalls bloqueadas, {} avisos",
        not_found,
    );

    Ok(())
}

/// Lê syscalls da stdin (uma por linha).
fn read_syscalls_from_stdin() -> Vec<String> {
    let stdin = io::stdin();
    let mut names = Vec::new();

    for line in stdin.lock().lines() {
        match line {
            Ok(l) => {
                let trimmed = l.trim().to_string();
                if !trimmed.is_empty() && !trimmed.starts_with('#') {
                    names.push(trimmed);
                }
            }
            Err(e) => {
                eprintln!("gen-seccomp: erro lendo stdin: {e}");
                break;
            }
        }
    }

    names
}

/// Exibe a lista de syscalls bloqueáveis com seus números x86_64.
fn print_syscall_list() {
    println!("Syscalls bloqueáveis (x86_64):");
    println!("{:<30} {:>6}", "Nome", "Nº");
    println!("{}", "-".repeat(38));

    for name in DEFAULT_BLOCKED {
        match ScmpSyscall::from_name(name) {
            Ok(syscall) => {
                // ScmpSyscall implementa Display/Debug mas podemos extrair o número
                println!("{name:<30} {:>6}", format!("{syscall:?}"));
            }
            Err(_) => {
                println!("{name:<30}      ─");
            }
        }
    }

    println!();
    println!("Use: gen-seccomp <nomes...> > seccomp.bpf");
    println!("     gen-seccomp --stdin < lista.txt > seccomp.bpf");
}
