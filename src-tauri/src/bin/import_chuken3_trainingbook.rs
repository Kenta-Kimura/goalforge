use std::{env, path::Path};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    match arguments.as_slice() {
        [command, database] if command == "preflight" => {
            goalforge_lib::chuken3_import::preflight(Path::new(database))?;
            println!("preflight: ok");
            Ok(())
        }
        [command, database] if command == "verify-app-load" => {
            let (materials, attempts) =
                goalforge_lib::chuken3_import::verify_app_load(Path::new(database))?;
            println!("materials={materials}, attempts={attempts}");
            Ok(())
        }
        [command, database, backup, payload] if command == "apply" => {
            let report = goalforge_lib::chuken3_import::apply(
                Path::new(database),
                Path::new(backup),
                Path::new(payload),
            )?;
            println!(
                "{}",
                serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?
            );
            Ok(())
        }
        _ => Err(
            "usage: import_chuken3_trainingbook preflight <db> | verify-app-load <db> | apply <db> <backup> <payload>".into(),
        ),
    }
}
