/// landlock-exec — Aplica Landlock filesystem allowlist e executa um comando.
///
/// Executado DENTRO do namespace bwrap, após mounts, capabilities e seccomp.
/// Cria uma política Landlock que restringe o processo (e todos os filhos)
/// a apenas os paths explicitamente permitidos.
///
/// Uso:
///   landlock-exec --probe-abi
///   landlock-exec --min-abi 3 --allow-ro /usr --allow-rw /tmp -- cmd arg1 arg2
///
/// Códigos de saída:
///   0   = sucesso (comando executou)
///   125 = falha ao aplicar Landlock
///   126 = execvp falhou (comando encontrado mas não executável)
///   127 = comando não encontrado

use std::env;
use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::process;

// ── Constantes Linux (não disponíveis no libc 0.2.189) ────────────

/// open(2): abre path sem realmente abrir o arquivo (usado com Landlock).
const O_PATH: libc::c_int = 0o10000000;

// ── Syscall numbers (x86_64) ──────────────────────────────────────

const SYS_LANDLOCK_CREATE_RULESET: libc::c_long = 444;
const SYS_LANDLOCK_ADD_RULE: libc::c_long = 445;
const SYS_LANDLOCK_RESTRICT_SELF: libc::c_long = 446;

// ── Flags landlock_create_ruleset ──────────────────────────────────

const LANDLOCK_CREATE_RULESET_VERSION: u32 = 1 << 0;

// ── Tipos de regra ─────────────────────────────────────────────────

const LANDLOCK_RULE_PATH_BENEATH: u64 = 1;

// ── Access rights (filesystem) ─────────────────────────────────────

const LANDLOCK_ACCESS_FS_EXECUTE: u64 = 1 << 0;
const LANDLOCK_ACCESS_FS_WRITE_FILE: u64 = 1 << 1;
const LANDLOCK_ACCESS_FS_READ_FILE: u64 = 1 << 2;
const LANDLOCK_ACCESS_FS_READ_DIR: u64 = 1 << 3;
const LANDLOCK_ACCESS_FS_REMOVE_DIR: u64 = 1 << 4;
const LANDLOCK_ACCESS_FS_REMOVE_FILE: u64 = 1 << 5;
#[allow(dead_code)]
const LANDLOCK_ACCESS_FS_MAKE_CHAR: u64 = 1 << 6;
const LANDLOCK_ACCESS_FS_MAKE_DIR: u64 = 1 << 7;
const LANDLOCK_ACCESS_FS_MAKE_REG: u64 = 1 << 8;
const LANDLOCK_ACCESS_FS_MAKE_SOCK: u64 = 1 << 9;
const LANDLOCK_ACCESS_FS_MAKE_FIFO: u64 = 1 << 10;
#[allow(dead_code)]
const LANDLOCK_ACCESS_FS_MAKE_BLOCK: u64 = 1 << 11;
const LANDLOCK_ACCESS_FS_MAKE_SYM: u64 = 1 << 12;
const LANDLOCK_ACCESS_FS_REFER: u64 = 1 << 13;
const LANDLOCK_ACCESS_FS_TRUNCATE: u64 = 1 << 14;
const LANDLOCK_ACCESS_FS_IOCTL_DEV: u64 = 1 << 15;

// ── Máscaras de access rights por ABI ──────────────────────────────
//
// Cada ABI introduz novos access rights. A máscara completa para uma
// ABI é (último_bit_da_abi << 1) - 1.

/// ABI 1 (Linux 5.13): EXECUTE..MAKE_SYM (bits 0-12).
const ABI1_FS_MASK: u64 = (LANDLOCK_ACCESS_FS_MAKE_SYM << 1) - 1;

/// ABI 2 (Linux 5.19): +REFER (bits 0-13).
const ABI2_FS_MASK: u64 = (LANDLOCK_ACCESS_FS_REFER << 1) - 1;

/// ABI 3 (Linux 6.2): +TRUNCATE (bits 0-14).
const ABI3_FS_MASK: u64 = (LANDLOCK_ACCESS_FS_TRUNCATE << 1) - 1;

/// ABI 5 (Linux 6.10): +IOCTL_DEV (bits 0-15).
const ABI5_FS_MASK: u64 = (LANDLOCK_ACCESS_FS_IOCTL_DEV << 1) - 1;

/// Máscara fs completa para cada ABI (índice = ABI; 0 = não usado).
const FS_MASK_BY_ABI: [u64; 6] = [
    0,
    ABI1_FS_MASK,
    ABI2_FS_MASK,
    ABI3_FS_MASK,
    ABI3_FS_MASK, // ABI 4 (Linux 6.7): só adiciona NET; fs igual ABI 3
    ABI5_FS_MASK,
];

// ── Permissões por nível ───────────────────────────────────────────

/// Permissões para paths read-only: ler, listar, executar.
const RO_ACCESS: u64 =
    LANDLOCK_ACCESS_FS_EXECUTE
    | LANDLOCK_ACCESS_FS_READ_FILE
    | LANDLOCK_ACCESS_FS_READ_DIR;

/// Permissões para paths read-write: tudo exceto device nodes e ioctl.
const RW_ACCESS: u64 =
    LANDLOCK_ACCESS_FS_EXECUTE
    | LANDLOCK_ACCESS_FS_READ_FILE
    | LANDLOCK_ACCESS_FS_READ_DIR
    | LANDLOCK_ACCESS_FS_WRITE_FILE
    | LANDLOCK_ACCESS_FS_TRUNCATE
    | LANDLOCK_ACCESS_FS_REMOVE_FILE
    | LANDLOCK_ACCESS_FS_REMOVE_DIR
    | LANDLOCK_ACCESS_FS_MAKE_REG
    | LANDLOCK_ACCESS_FS_MAKE_DIR
    | LANDLOCK_ACCESS_FS_MAKE_SOCK
    | LANDLOCK_ACCESS_FS_MAKE_FIFO
    | LANDLOCK_ACCESS_FS_MAKE_SYM
    | LANDLOCK_ACCESS_FS_REFER;

/// RW_ACCESS + permissão para criar device nodes (char e block).
/// **Nunca** concedida pelo landlock-exec por padrão.
const _RW_DEV_ACCESS: u64 = RW_ACCESS
    | LANDLOCK_ACCESS_FS_MAKE_CHAR
    | LANDLOCK_ACCESS_FS_MAKE_BLOCK;

// ── Estruturas compatíveis com kernel ABI ───────────────────────────

#[repr(C)]
struct LandlockRulesetAttr {
    handled_access_fs: u64,
    _handled_access_net: u64,  // não usado (reservado para ABI futura)
    _scoped: u64,              // não usado (reservado para ABI futura)
}

#[repr(C)]
struct LandlockPathBeneathAttr {
    allowed_access: u64,
    parent_fd: i32,
}

// ── Syscall wrappers ────────────────────────────────────────────────

unsafe fn landlock_create_ruleset(
    attr: *const LandlockRulesetAttr,
    size: usize,
    flags: u32,
) -> libc::c_long {
    libc::syscall(SYS_LANDLOCK_CREATE_RULESET, attr, size, flags)
}

unsafe fn landlock_add_rule(
    ruleset_fd: libc::c_int,
    rule_type: u64,
    rule_attr: *const LandlockPathBeneathAttr,
    flags: u32,
) -> libc::c_long {
    libc::syscall(
        SYS_LANDLOCK_ADD_RULE,
        ruleset_fd,
        rule_type,
        rule_attr,
        flags,
    )
}

unsafe fn landlock_restrict_self(ruleset_fd: libc::c_int, flags: u32) -> libc::c_long {
    libc::syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset_fd, flags)
}

// ── Probe de ABI ────────────────────────────────────────────────────

/// Consulta a ABI Landlock suportada pelo kernel.
/// Retorna 0 se Landlock não estiver disponível.
fn probe_abi() -> i32 {
    let ret = unsafe {
        landlock_create_ruleset(
            std::ptr::null(),
            0,
            LANDLOCK_CREATE_RULESET_VERSION,
        )
    };
    if ret < 0 {
        0
    } else {
        ret as i32
    }
}

// ── Aplicação de regra ──────────────────────────────────────────────

/// Abre um path com O_PATH e adiciona uma regra `path_beneath` ao ruleset.
/// Se o path não existir, emite aviso e segue (path opcional como /lib64).
fn allow_path(ruleset_fd: libc::c_int, path: &Path, access: u64) {
    let cpath = CString::new(path.as_os_str().as_bytes())
        .unwrap_or_else(|_| {
            eprintln!("landlock-exec: aviso — path contém NUL: {}", path.display());
            // CString não aceita \0 interno; retornamos um path truncado
            // que certamente falhará no open — seguro, pois evita pânico.
            CString::new("").unwrap()
        });

    let fd = unsafe { libc::open(cpath.as_ptr(), O_PATH | libc::O_CLOEXEC) };
    if fd < 0 {
        let err = unsafe { *libc::__errno_location() };
        // ENOENT: path não existe (ex: /lib64 em sistemas sem multilib)
        if err == libc::ENOENT {
            eprintln!(
                "landlock-exec: aviso — path não existe, ignorado: {}",
                path.display()
            );
        } else {
            eprintln!(
                "landlock-exec: aviso — não foi possível abrir '{}' (errno={}): regra não aplicada",
                path.display(),
                err,
            );
        }
        return;
    }

    let attr = LandlockPathBeneathAttr {
        allowed_access: access,
        parent_fd: fd,
    };

    let ret = unsafe {
        landlock_add_rule(
            ruleset_fd,
            LANDLOCK_RULE_PATH_BENEATH,
            &attr as *const _,
            0,
        )
    };

    unsafe { libc::close(fd) };

    if ret != 0 {
        let err = unsafe { *libc::__errno_location() };
        eprintln!(
            "landlock-exec: erro ao adicionar regra para '{}' (errno={})",
            path.display(),
            err,
        );
    }
}

// ── Help ────────────────────────────────────────────────────────────

fn print_help() {
    eprintln!("landlock-exec — Aplica Landlock filesystem allowlist e executa comando.");
    eprintln!();
    eprintln!("Uso:");
    eprintln!("  landlock-exec --probe-abi");
    eprintln!("  landlock-exec [--min-abi N] --allow-ro PATH... --allow-rw PATH... -- cmd [args...]");
    eprintln!();
    eprintln!("Opções:");
    eprintln!("  --probe-abi       Consulta ABI Landlock do kernel e sai.");
    eprintln!("  --min-abi N       ABI mínima exigida (padrão: 3).");
    eprintln!("  --allow-ro PATH   Permite leitura + execução em PATH.");
    eprintln!("  --allow-rw PATH   Permite leitura + escrita em PATH.");
    eprintln!("  --                Separador obrigatório antes do comando.");
    eprintln!();
    eprintln!("Códigos de saída:");
    eprintln!("  0   = sucesso");
    eprintln!("  125 = falha ao aplicar Landlock");
    eprintln!("  126 = execvp falhou");
    eprintln!("  127 = comando não encontrado");
}

// ── Main ────────────────────────────────────────────────────────────

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    // ── --help / -h ──────────────────────────
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print_help();
        process::exit(0);
    }

    // ── --probe-abi ──────────────────────────
    if args.iter().any(|a| a == "--probe-abi") {
        let abi = probe_abi();
        println!("{abi}");
        process::exit(if abi > 0 { 0 } else { 1 });
    }

    // ── Parse de argumentos ──────────────────
    let mut min_abi: u32 = 3;
    let mut ro_paths: Vec<String> = Vec::new();
    let mut rw_paths: Vec<String> = Vec::new();
    let mut command_start: Option<usize> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--min-abi" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("landlock-exec: --min-abi requer um número.");
                    process::exit(125);
                }
                min_abi = args[i].parse().unwrap_or_else(|_| {
                    eprintln!("landlock-exec: --min-abi inválido: {}", args[i]);
                    process::exit(125);
                });
                if min_abi < 1 || min_abi > 5 {
                    eprintln!("landlock-exec: --min-abi deve estar entre 1 e 5, recebeu {min_abi}");
                    process::exit(125);
                }
            }
            "--allow-ro" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("landlock-exec: --allow-ro requer um caminho.");
                    process::exit(125);
                }
                ro_paths.push(args[i].clone());
            }
            "--allow-rw" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("landlock-exec: --allow-rw requer um caminho.");
                    process::exit(125);
                }
                rw_paths.push(args[i].clone());
            }
            "--" => {
                command_start = Some(i + 1);
                break;
            }
            other => {
                eprintln!("landlock-exec: argumento desconhecido: {other}");
                process::exit(125);
            }
        }
        i += 1;
    }

    let cmd_args: Vec<String> = match command_start {
        Some(start) if start < args.len() => args[start..].to_vec(),
        _ => {
            eprintln!("landlock-exec: comando não fornecido. Use '--' antes do comando.");
            process::exit(125);
        }
    };

    if ro_paths.is_empty() && rw_paths.is_empty() {
        eprintln!("landlock-exec: nenhum path permitido. Use --allow-ro ou --allow-rw.");
        process::exit(125);
    }

    // ── Probe ABI e valida ──────────────────
    let abi = probe_abi();
    if abi < 1 {
        eprintln!("landlock-exec: Landlock não está disponível neste kernel.");
        process::exit(125);
    }

    if (abi as u32) < min_abi {
        eprintln!(
            "landlock-exec: kernel suporta ABI {abi}, mas --min-abi exige {min_abi}.",
        );
        process::exit(125);
    }

    // ── Cria ruleset ────────────────────────
    let fs_mask = if (abi as usize) < FS_MASK_BY_ABI.len() {
        FS_MASK_BY_ABI[abi as usize]
    } else {
        // ABI futura: usa a maior máscara conhecida
        ABI5_FS_MASK
    };

    let attr = LandlockRulesetAttr {
        handled_access_fs: fs_mask,
        _handled_access_net: 0,
        _scoped: 0,
    };

    let ruleset_fd = unsafe {
        landlock_create_ruleset(&attr as *const _, std::mem::size_of::<LandlockRulesetAttr>(), 0)
    };

    if ruleset_fd < 0 {
        let err = unsafe { *libc::__errno_location() };
        eprintln!("landlock-exec: falha ao criar ruleset (errno={err}).");
        process::exit(125);
    }
    let ruleset_fd = ruleset_fd as libc::c_int;

    // ── Adiciona regras ─────────────────────
    for p in &ro_paths {
        allow_path(ruleset_fd, Path::new(p), RO_ACCESS);
    }
    for p in &rw_paths {
        allow_path(ruleset_fd, Path::new(p), RW_ACCESS);
    }

    // ── no_new_privs ───────────────────────
    // landlock_restrict_self requer CAP_SYS_ADMIN no user namespace
    // OU no_new_privs ativo. Dentro do bwrap com --unshare-all, o
    // processo tem CAP_SYS_ADMIN no namespace próprio — não precisa
    // de prctl. Se falhar, landlock_restrict_self reporta o errno.

    // ── Aplica Landlock ─────────────────────
    let ret = unsafe { landlock_restrict_self(ruleset_fd, 0) };
    unsafe { libc::close(ruleset_fd) };

    if ret != 0 {
        let err = unsafe { *libc::__errno_location() };
        eprintln!("landlock-exec: falha ao aplicar Landlock (errno={err}).");
        process::exit(125);
    }

    // ── execvp ──────────────────────────────
    let cmd_cstr = CString::new(cmd_args[0].as_bytes()).unwrap_or_else(|_| {
        eprintln!("landlock-exec: nome do comando contém NUL.");
        process::exit(125);
    });

    // Constrói argv: array de *const c_char terminado em null
    let mut argv_c: Vec<CString> = Vec::with_capacity(cmd_args.len());
    for arg in &cmd_args {
        match CString::new(arg.as_bytes()) {
            Ok(cs) => argv_c.push(cs),
            Err(_) => {
                eprintln!("landlock-exec: argumento contém NUL: {arg}");
                process::exit(125);
            }
        }
    }
    let mut argv_p: Vec<*const libc::c_char> = argv_c.iter().map(|cs| cs.as_ptr()).collect();
    argv_p.push(std::ptr::null());

    unsafe {
        libc::execvp(cmd_cstr.as_ptr(), argv_p.as_ptr());
    }

    // execvp só retorna em caso de erro
    let err = unsafe { *libc::__errno_location() };
    match err {
        libc::ENOENT => {
            eprintln!("landlock-exec: comando não encontrado: {}", cmd_args[0]);
            process::exit(127);
        }
        libc::EACCES | libc::EPERM => {
            eprintln!("landlock-exec: permissão negada ao executar: {}", cmd_args[0]);
            process::exit(126);
        }
        _ => {
            eprintln!(
                "landlock-exec: falha ao executar '{}' (errno={err}).",
                cmd_args[0],
            );
            process::exit(126);
        }
    }
}
