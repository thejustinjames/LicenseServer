//! Command-line interface for license management

use license_client::{LicenseClient, LicenseClientConfig};
use std::env;
use std::process::ExitCode;

fn print_usage() {
    eprintln!(
        r#"License CLI - License validation tool

Usage: license-cli <command> [options]

Commands:
    validate <license-key>              Validate a license key
    activate <license-key> [name]       Activate license on this machine
    deactivate <license-key>            Deactivate license from this machine
    fingerprint                         Show machine fingerprint
    help                                Show this help message

Environment:
    LICENSE_SERVER_URL    License server URL (required)
    LICENSE_PRODUCT_ID    Product ID (optional)

Examples:
    export LICENSE_SERVER_URL=https://license.example.com
    license-cli validate XXXX-XXXX-XXXX-XXXX
    license-cli activate XXXX-XXXX-XXXX-XXXX "My Computer"
"#
    );
}

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        print_usage();
        return ExitCode::FAILURE;
    }

    let command = &args[1];

    if command == "help" || command == "--help" || command == "-h" {
        print_usage();
        return ExitCode::SUCCESS;
    }

    let server_url = match env::var("LICENSE_SERVER_URL") {
        Ok(url) => url,
        Err(_) => {
            eprintln!("Error: LICENSE_SERVER_URL environment variable not set");
            return ExitCode::FAILURE;
        }
    };

    let client = LicenseClient::new(LicenseClientConfig {
        server_url,
        product_id: env::var("LICENSE_PRODUCT_ID").ok(),
        ..Default::default()
    });

    match command.as_str() {
        "fingerprint" => {
            println!("{}", client.get_machine_fingerprint());
            ExitCode::SUCCESS
        }

        "validate" => {
            if args.len() < 3 {
                eprintln!("Error: License key required");
                eprintln!("Usage: license-cli validate <license-key>");
                return ExitCode::FAILURE;
            }

            let license_key = &args[2];
            let result = client.validate(license_key).await;

            if result.valid {
                println!("License: VALID");
                if let Some(product) = &result.product {
                    println!("Product: {}", product);
                }
                if let Some(features) = &result.features {
                    println!("Features: {}", features.join(", "));
                }
                if let Some(expires) = &result.expires_at {
                    println!("Expires: {}", expires);
                }
                if result.cached {
                    println!("(cached)");
                }
                ExitCode::SUCCESS
            } else {
                eprintln!("License: INVALID");
                if let Some(error) = &result.error {
                    eprintln!("Error: {}", error);
                }
                ExitCode::FAILURE
            }
        }

        "activate" => {
            if args.len() < 3 {
                eprintln!("Error: License key required");
                eprintln!("Usage: license-cli activate <license-key> [machine-name]");
                return ExitCode::FAILURE;
            }

            let license_key = &args[2];
            let machine_name = args.get(3).map(|s| s.as_str());

            let result = client.activate(license_key, machine_name).await;

            if result.success {
                println!("Activation: SUCCESS");
                if let Some(info) = &result.activation {
                    println!("Machine: {}", info.machine_fingerprint);
                    println!("Activated: {}", info.activated_at);
                }
                ExitCode::SUCCESS
            } else {
                eprintln!("Activation: FAILED");
                if let Some(error) = &result.error {
                    eprintln!("Error: {}", error);
                }
                ExitCode::FAILURE
            }
        }

        "deactivate" => {
            if args.len() < 3 {
                eprintln!("Error: License key required");
                eprintln!("Usage: license-cli deactivate <license-key>");
                return ExitCode::FAILURE;
            }

            let license_key = &args[2];
            let result = client.deactivate(license_key).await;

            if result.success {
                println!("Deactivation: SUCCESS");
                ExitCode::SUCCESS
            } else {
                eprintln!("Deactivation: FAILED");
                if let Some(error) = &result.error {
                    eprintln!("Error: {}", error);
                }
                ExitCode::FAILURE
            }
        }

        _ => {
            eprintln!("Unknown command: {}", command);
            print_usage();
            ExitCode::FAILURE
        }
    }
}
