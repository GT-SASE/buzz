# Reads the text form of a dump's data, as `pg_restore --data-only -f -` prints it,
# and prints one line per table: "<schema.table> <rows>". Row text goes no further than
# this process, except to the digest command when one is set.
#
# COPY text format escapes newlines and backslashes inside a value, so each row is one
# line, and a line of exactly \. can only be the end of a block. Everything between a
# COPY header and that line is ignored as data, so row text cannot forge a header.
#
# With -v digest_cmd=... -v digest_dir=..., each table's rows are also piped to the
# digest command, and its first output field is added to that table's line, or "-" for
# an empty table. Table names never reach the shell. Files are numbered instead.

!in_copy && /^COPY .* FROM stdin;$/ {
  name = $0
  sub(/^COPY /, "", name)
  sub(/ FROM stdin;$/, "", name)
  sub(/ \(.*$/, "", name)
  in_copy = 1
  rows = 0
  tables++
  if (digest_cmd != "") {
    digest_file = digest_dir "/" tables
    cmd = digest_cmd " > '" digest_file "'"
  }
  next
}

in_copy && $0 == "\\." {
  in_copy = 0
  if (digest_cmd == "") {
    print name, rows
    next
  }
  digest = "-"
  if (rows > 0) {
    close(cmd)
    getline digest < digest_file
    close(digest_file)
    split(digest, fields, " ")
    digest = fields[1]
  }
  print name, rows, digest
  next
}

in_copy {
  rows++
  if (digest_cmd != "") {
    print | cmd
  }
}

END {
  if (in_copy) {
    print "copy-summary: a table's data ended before its terminator" > "/dev/stderr"
    exit 1
  }
}
