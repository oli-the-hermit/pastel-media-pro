//! Writes the test library for the web version's dev server: `library.json` and `covers/<album id>.jpg`, from the
//! same scanner the desktop app uses. Usage: `library-export <folder> <out dir>`. Built only with `test-media`.

use std::path::PathBuf;

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(root), Some(out)) = (args.next(), args.next()) else {
        eprintln!("usage: library-export <folder> <out dir>");
        std::process::exit(2);
    };
    let root = PathBuf::from(root).canonicalize().unwrap_or_else(|e| {
        eprintln!("cannot read the folder: {e}");
        std::process::exit(1);
    });
    let out = PathBuf::from(out);
    let covers = out.join("covers");
    std::fs::create_dir_all(&covers).expect("cannot create the out dir");

    let (library, sources) = app_lib::library::scan(&root);
    let mut jobs: Vec<_> = sources.into_iter().collect();
    jobs.sort();
    // Covers in parallel: decoding them is most of the time.
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    let made = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|s| {
        for chunk in jobs.chunks(jobs.len().div_ceil(threads).max(1)) {
            let (covers, made) = (&covers, &made);
            s.spawn(move || {
                for (id, files) in chunk {
                    if let Some(jpg) = app_lib::library::cover_thumbnail(files) {
                        if std::fs::write(covers.join(format!("{id}.jpg")), jpg).is_ok() {
                            made.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        }
                    }
                }
            });
        }
    });
    let json = serde_json::to_string(&library).expect("serialize");
    std::fs::write(out.join("library.json"), json).expect("cannot write library.json");
    println!(
        "{} songs, {} albums ({} covers), {} movies, {} series",
        library.tracks.len(),
        library.albums.len(),
        made.into_inner(),
        library.movies.len(),
        library.series.len()
    );
}
