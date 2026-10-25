# PhotoGoGo's fixed entry point for the private, source-built interpreter.
# Resolve modules only inside the installed runtime, never a developer prefix.
BEGIN { @INC = ('./lib'); }
$0 = './exiftool.pl';
my $loaded = do $0;
die $@ if $@;
die "Could not load the packaged ExifTool script: $!\n" unless defined $loaded;
