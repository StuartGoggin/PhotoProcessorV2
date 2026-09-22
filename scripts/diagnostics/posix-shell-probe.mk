all:
	@printf '%s\n' 'including file: C:\sdk\foo.h' | awk '/including/ { sub(/^.*file: */, ""); gsub(/\\/, "/"); if (!match($$0, / /)) print "object.o:", $$0 }'
