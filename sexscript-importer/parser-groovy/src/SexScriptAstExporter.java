import groovy.json.JsonOutput;
import groovy.lang.GroovySystem;
import groovyjarjarantlr.Token;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.codehaus.groovy.antlr.parser.GroovyLexer;
import org.codehaus.groovy.antlr.parser.GroovyTokenTypes;
import org.codehaus.groovy.ast.ASTNode;
import org.codehaus.groovy.ast.ClassNode;
import org.codehaus.groovy.ast.FieldNode;
import org.codehaus.groovy.ast.MethodNode;
import org.codehaus.groovy.ast.Parameter;
import org.codehaus.groovy.ast.builder.AstBuilder;
import org.codehaus.groovy.ast.expr.ArgumentListExpression;
import org.codehaus.groovy.ast.expr.ArrayExpression;
import org.codehaus.groovy.ast.expr.AttributeExpression;
import org.codehaus.groovy.ast.expr.BinaryExpression;
import org.codehaus.groovy.ast.expr.BitwiseNegationExpression;
import org.codehaus.groovy.ast.expr.BooleanExpression;
import org.codehaus.groovy.ast.expr.CastExpression;
import org.codehaus.groovy.ast.expr.ClassExpression;
import org.codehaus.groovy.ast.expr.ClosureExpression;
import org.codehaus.groovy.ast.expr.ClosureListExpression;
import org.codehaus.groovy.ast.expr.ConstantExpression;
import org.codehaus.groovy.ast.expr.ConstructorCallExpression;
import org.codehaus.groovy.ast.expr.DeclarationExpression;
import org.codehaus.groovy.ast.expr.ElvisOperatorExpression;
import org.codehaus.groovy.ast.expr.Expression;
import org.codehaus.groovy.ast.expr.FieldExpression;
import org.codehaus.groovy.ast.expr.GStringExpression;
import org.codehaus.groovy.ast.expr.ListExpression;
import org.codehaus.groovy.ast.expr.MapEntryExpression;
import org.codehaus.groovy.ast.expr.MapExpression;
import org.codehaus.groovy.ast.expr.MethodCallExpression;
import org.codehaus.groovy.ast.expr.MethodPointerExpression;
import org.codehaus.groovy.ast.expr.NotExpression;
import org.codehaus.groovy.ast.expr.PostfixExpression;
import org.codehaus.groovy.ast.expr.PrefixExpression;
import org.codehaus.groovy.ast.expr.PropertyExpression;
import org.codehaus.groovy.ast.expr.RangeExpression;
import org.codehaus.groovy.ast.expr.SpreadExpression;
import org.codehaus.groovy.ast.expr.SpreadMapExpression;
import org.codehaus.groovy.ast.expr.StaticMethodCallExpression;
import org.codehaus.groovy.ast.expr.TernaryExpression;
import org.codehaus.groovy.ast.expr.TupleExpression;
import org.codehaus.groovy.ast.expr.UnaryMinusExpression;
import org.codehaus.groovy.ast.expr.UnaryPlusExpression;
import org.codehaus.groovy.ast.expr.VariableExpression;
import org.codehaus.groovy.ast.stmt.AssertStatement;
import org.codehaus.groovy.ast.stmt.BlockStatement;
import org.codehaus.groovy.ast.stmt.BreakStatement;
import org.codehaus.groovy.ast.stmt.CaseStatement;
import org.codehaus.groovy.ast.stmt.CatchStatement;
import org.codehaus.groovy.ast.stmt.ContinueStatement;
import org.codehaus.groovy.ast.stmt.DoWhileStatement;
import org.codehaus.groovy.ast.stmt.EmptyStatement;
import org.codehaus.groovy.ast.stmt.ExpressionStatement;
import org.codehaus.groovy.ast.stmt.ForStatement;
import org.codehaus.groovy.ast.stmt.IfStatement;
import org.codehaus.groovy.ast.stmt.ReturnStatement;
import org.codehaus.groovy.ast.stmt.Statement;
import org.codehaus.groovy.ast.stmt.SwitchStatement;
import org.codehaus.groovy.ast.stmt.SynchronizedStatement;
import org.codehaus.groovy.ast.stmt.ThrowStatement;
import org.codehaus.groovy.ast.stmt.TryCatchStatement;
import org.codehaus.groovy.ast.stmt.WhileStatement;
import org.codehaus.groovy.control.CompilePhase;

public final class SexScriptAstExporter {
    private static final int FORMAT_VERSION = 1;
    private final int lineOffset;

    private SexScriptAstExporter(int lineOffset) {
        this.lineOffset = lineOffset;
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 2 || !(args[0].equals("script-body") || args[0].equals("unit"))) {
            System.err.println("Usage: SexScriptAstExporter <script-body|unit> <source.groovy>");
            System.exit(2);
        }

        String mode = args[0];
        Path sourcePath = Path.of(args[1]);
        String source = Files.readString(sourcePath, StandardCharsets.UTF_8);

        Map<String, Object> output;
        try {
            output = mode.equals("script-body")
                    ? exportScriptBody(sourcePath.toString(), source)
                    : exportCompilationUnit(sourcePath.toString(), source);
        } catch (Throwable error) {
            output = new LinkedHashMap<>();
            output.put("formatVersion", FORMAT_VERSION);
            output.put("sourceName", sourcePath.toString());
            output.put("groovyVersion", GroovySystem.getVersion());
            output.put("mode", mode);
            output.put("root", null);
            output.put("diagnostics", List.of(diagnostic("GROOVY_PARSE_ERROR", error.getMessage())));
        }

        System.out.println(JsonOutput.toJson(output));
    }

    private static Map<String, Object> exportScriptBody(String sourceName, String source) {
        String prefix = "class __SexScriptImportWrapper {\n  def run() {\n";
        String wrapped = prefix + source + "\n  }\n}\n";
        List<ASTNode> nodes = new AstBuilder().buildFromString(CompilePhase.CONVERSION, false, wrapped);
        ClassNode wrapper = null;
        for (ASTNode node : nodes) {
            if (node instanceof ClassNode classNode && classNode.getNameWithoutPackage().equals("__SexScriptImportWrapper")) {
                wrapper = classNode;
                break;
            }
        }
        if (wrapper == null) {
            throw new IllegalStateException("Groovy parser did not return the SexScript wrapper class");
        }
        MethodNode run = wrapper.getMethod("run", Parameter.EMPTY_ARRAY);
        if (run == null || run.getCode() == null) {
            throw new IllegalStateException("Groovy parser did not return the SexScript wrapper run() body");
        }

        SexScriptAstExporter exporter = new SexScriptAstExporter(2);
        // Anonymous and nested classes declared inside the script body are separate class nodes; constructor
        // calls refer to them by name.
        List<Object> classes = new ArrayList<>();
        for (ASTNode node : nodes) {
            if (node instanceof ClassNode classNode && classNode != wrapper) {
                classes.add(exporter.classNode(classNode));
            }
        }
        Map<String, Object> root = mapOf(
                "kind", "scriptBody",
                "body", exporter.statement(run.getCode()),
                "classes", classes);
        return file(sourceName, "script-body", root, source);
    }

    private static Map<String, Object> exportCompilationUnit(String sourceName, String source) {
        List<ASTNode> nodes = new AstBuilder().buildFromString(CompilePhase.CONVERSION, false, source);
        SexScriptAstExporter exporter = new SexScriptAstExporter(0);
        List<Object> classes = new ArrayList<>();
        Statement topLevel = null;
        for (ASTNode node : nodes) {
            if (node instanceof ClassNode classNode) {
                if (!classNode.isScript()) {
                    classes.add(exporter.classNode(classNode));
                }
            } else if (node instanceof BlockStatement blockStatement) {
                topLevel = blockStatement;
            }
        }
        Map<String, Object> root = mapOf(
                "kind", "compilationUnit",
                "topLevel", topLevel == null ? null : exporter.statement(topLevel),
                "classes", classes);
        return file(sourceName, "unit", root, source);
    }

    private static Map<String, Object> file(
            String sourceName, String mode, Map<String, Object> root, String source) {
        return mapOf(
                "formatVersion", FORMAT_VERSION,
                "sourceName", sourceName,
                "groovyVersion", GroovySystem.getVersion(),
                "mode", mode,
                "root", root,
                "source", source,
                "comments", comments(source),
                "diagnostics", List.of());
    }

    /**
     * The Groovy AST drops comments. Re-lex the original source with the same Groovy lexer so string, GString,
     * and slashy-string contents are never mistaken for comments.
     */
    private static List<Object> comments(String source) {
        List<Integer> lineStarts = new ArrayList<>();
        lineStarts.add(0);
        // LF, CRLF, and lone CR all end a line, as they do for the Groovy lexer.
        for (int index = 0; index < source.length(); index += 1) {
            char character = source.charAt(index);
            if (character == '\r' && index + 1 < source.length() && source.charAt(index + 1) == '\n') {
                continue;
            }
            if (character == '\n' || character == '\r') {
                lineStarts.add(index + 1);
            }
        }
        List<Object> result = new ArrayList<>();
        try {
            GroovyLexer lexer = new GroovyLexer(new StringReader(source));
            lexer.setWhitespaceIncluded(true);
            lexer.setTabSize(1);
            // plumb() is the parser-facing stream; it tracks GString and division/regex context.
            groovyjarjarantlr.TokenStream tokens = lexer.plumb();
            for (Token token = tokens.nextToken(); token.getType() != Token.EOF_TYPE; token = tokens.nextToken()) {
                int type = token.getType();
                if (type != GroovyTokenTypes.SL_COMMENT && type != GroovyTokenTypes.ML_COMMENT) {
                    continue;
                }
                // ANTLR drops newlines from comment token text, so read the exact text from the source.
                int start = lineStarts.get(token.getLine() - 1) + token.getColumn() - 1;
                int end;
                if (type == GroovyTokenTypes.ML_COMMENT) {
                    end = source.indexOf("*/", start + 2) + 2;
                } else {
                    end = start;
                    while (end < source.length() && source.charAt(end) != '\n' && source.charAt(end) != '\r') {
                        end += 1;
                    }
                }
                String text = source.substring(start, end).stripTrailing();
                int endLine = token.getLine() + (int) text.split("\r\n|\r|\n", -1).length - 1;
                result.add(mapOf(
                        "line", token.getLine(),
                        "column", token.getColumn(),
                        "endLine", endLine,
                        "text", text));
            }
        } catch (Exception error) {
            // Comments are presentation only; the AST export remains authoritative when re-lexing fails.
            return List.of();
        }
        return result;
    }

    private Map<String, Object> classNode(ClassNode node) {
        List<Object> fields = new ArrayList<>();
        for (FieldNode field : node.getFields()) {
            if (field.getOwner() != node) {
                continue;
            }
            fields.add(fieldNode(field));
        }
        List<Object> methods = new ArrayList<>();
        for (MethodNode method : node.getMethods()) {
            if (method.getDeclaringClass() != node || method.isSynthetic()) {
                continue;
            }
            methods.add(methodNode(method));
        }
        return nodeMap(node,
                "class",
                "name", node.getName(),
                "outerClass", node.getOuterClass() == null ? null : node.getOuterClass().getName(),
                "modifiers", node.getModifiers(),
                "fields", fields,
                "methods", methods);
    }

    private Map<String, Object> fieldNode(FieldNode node) {
        return nodeMap(node,
                "field",
                "name", node.getName(),
                "type", node.getType().getName(),
                "modifiers", node.getModifiers(),
                "static", node.isStatic(),
                "final", node.isFinal(),
                "initialExpression", node.hasInitialExpression() ? expression(node.getInitialExpression()) : null);
    }

    private Map<String, Object> methodNode(MethodNode node) {
        List<Object> parameters = new ArrayList<>();
        for (Parameter parameter : node.getParameters()) {
            parameters.add(mapOf(
                    "name", parameter.getName(),
                    "type", parameter.getType().getName(),
                    "hasInitialExpression", parameter.hasInitialExpression(),
                    "initialExpression", parameter.hasInitialExpression() ? expression(parameter.getInitialExpression()) : null));
        }
        return nodeMap(node,
                "method",
                "name", node.getName(),
                "returnType", node.getReturnType().getName(),
                "modifiers", node.getModifiers(),
                "parameters", parameters,
                "body", node.getCode() == null ? null : statement(node.getCode()));
    }

    private Map<String, Object> statement(Statement node) {
        if (node == null) {
            return null;
        }
        if (node instanceof BlockStatement block) {
            List<Object> statements = new ArrayList<>();
            for (Statement child : block.getStatements()) {
                statements.add(statement(child));
            }
            return nodeMap(node, "block", "statements", statements);
        }
        if (node instanceof ExpressionStatement child) {
            return nodeMap(node, "expressionStatement", "expression", expression(child.getExpression()));
        }
        if (node instanceof IfStatement child) {
            return nodeMap(node, "if",
                    "condition", expression(child.getBooleanExpression().getExpression()),
                    "then", statement(child.getIfBlock()),
                    "else", statement(child.getElseBlock()));
        }
        if (node instanceof WhileStatement child) {
            return nodeMap(node, "while",
                    "condition", expression(child.getBooleanExpression().getExpression()),
                    "body", statement(child.getLoopBlock()));
        }
        if (node instanceof DoWhileStatement child) {
            return nodeMap(node, "doWhile",
                    "condition", expression(child.getBooleanExpression().getExpression()),
                    "body", statement(child.getLoopBlock()));
        }
        if (node instanceof ForStatement child) {
            return nodeMap(node, "for",
                    "variable", child.getVariable().getName(),
                    "collection", expression(child.getCollectionExpression()),
                    "body", statement(child.getLoopBlock()));
        }
        if (node instanceof SwitchStatement child) {
            List<Object> cases = new ArrayList<>();
            for (CaseStatement caseStatement : child.getCaseStatements()) {
                cases.add(statement(caseStatement));
            }
            return nodeMap(node, "switch",
                    "expression", expression(child.getExpression()),
                    "cases", cases,
                    "default", statement(child.getDefaultStatement()));
        }
        if (node instanceof CaseStatement child) {
            return nodeMap(node, "case",
                    "expression", expression(child.getExpression()),
                    "body", statement(child.getCode()));
        }
        if (node instanceof ReturnStatement child) {
            return nodeMap(node, "return", "value", expression(child.getExpression()));
        }
        if (node instanceof BreakStatement) {
            return nodeMap(node, "break");
        }
        if (node instanceof ContinueStatement) {
            return nodeMap(node, "continue");
        }
        if (node instanceof ThrowStatement child) {
            return nodeMap(node, "throw", "value", expression(child.getExpression()));
        }
        if (node instanceof TryCatchStatement child) {
            List<Object> catches = new ArrayList<>();
            for (CatchStatement catchStatement : child.getCatchStatements()) {
                catches.add(statement(catchStatement));
            }
            return nodeMap(node, "tryCatch",
                    "try", statement(child.getTryStatement()),
                    "catches", catches,
                    "finally", statement(child.getFinallyStatement()));
        }
        if (node instanceof CatchStatement child) {
            return nodeMap(node, "catch",
                    "variable", child.getVariable().getName(),
                    "type", child.getVariable().getType().getName(),
                    "body", statement(child.getCode()));
        }
        if (node instanceof SynchronizedStatement child) {
            return nodeMap(node, "synchronized",
                    "expression", expression(child.getExpression()),
                    "body", statement(child.getCode()));
        }
        if (node instanceof AssertStatement child) {
            return nodeMap(node, "assert",
                    "condition", expression(child.getBooleanExpression().getExpression()),
                    "message", expression(child.getMessageExpression()));
        }
        if (node instanceof EmptyStatement) {
            return nodeMap(node, "empty");
        }
        return nodeMap(node, "unsupportedStatement", "groovyType", node.getClass().getName());
    }

    private Map<String, Object> expression(Expression node) {
        if (node == null) {
            return null;
        }
        if (node instanceof ConstantExpression child) {
            Object value = child.getValue();
            if (value instanceof Character character) {
                value = character.toString();
            } else if (!(value == null || value instanceof String || value instanceof Number || value instanceof Boolean)) {
                value = String.valueOf(value);
            }
            return nodeMap(node, "constant", "value", value);
        }
        if (node instanceof VariableExpression child) {
            return nodeMap(node, "variable", "name", child.getName(), "type", child.getType().getName());
        }
        if (node instanceof DeclarationExpression child) {
            return nodeMap(node, "declaration",
                    "multipleAssignment", child.isMultipleAssignmentDeclaration(),
                    "left", expression(child.getLeftExpression()),
                    "right", expression(child.getRightExpression()));
        }
        if (node instanceof BinaryExpression child) {
            return nodeMap(node, "binary",
                    "operator", child.getOperation().getText(),
                    "left", expression(child.getLeftExpression()),
                    "right", expression(child.getRightExpression()));
        }
        if (node instanceof MethodCallExpression child) {
            return nodeMap(node, "methodCall",
                    "object", expression(child.getObjectExpression()),
                    "method", expression(child.getMethod()),
                    "arguments", expression(child.getArguments()),
                    "implicitThis", child.isImplicitThis(),
                    "safe", child.isSafe(),
                    "spreadSafe", child.isSpreadSafe());
        }
        if (node instanceof StaticMethodCallExpression child) {
            return nodeMap(node, "staticMethodCall",
                    "ownerType", child.getOwnerType().getName(),
                    "method", child.getMethod(),
                    "arguments", expression(child.getArguments()));
        }
        if (node instanceof ConstructorCallExpression child) {
            return nodeMap(node, "constructorCall",
                    "type", child.getType().getName(),
                    "arguments", expression(child.getArguments()));
        }
        if (node instanceof PropertyExpression child) {
            return nodeMap(node, "property",
                    "object", expression(child.getObjectExpression()),
                    "property", expression(child.getProperty()),
                    "safe", child.isSafe(),
                    "spreadSafe", child.isSpreadSafe());
        }
        if (node instanceof AttributeExpression child) {
            return nodeMap(node, "attribute",
                    "object", expression(child.getObjectExpression()),
                    "property", expression(child.getProperty()));
        }
        if (node instanceof ListExpression child) {
            return nodeMap(node, "list", "items", expressions(child.getExpressions()));
        }
        if (node instanceof MapExpression child) {
            List<Object> entries = new ArrayList<>();
            for (MapEntryExpression entry : child.getMapEntryExpressions()) {
                entries.add(expression(entry));
            }
            return nodeMap(node, "map", "entries", entries);
        }
        if (node instanceof MapEntryExpression child) {
            return nodeMap(node, "mapEntry",
                    "key", expression(child.getKeyExpression()),
                    "value", expression(child.getValueExpression()));
        }
        if (node instanceof RangeExpression child) {
            return nodeMap(node, "range",
                    "from", expression(child.getFrom()),
                    "to", expression(child.getTo()),
                    "inclusive", child.isInclusive());
        }
        if (node instanceof ClosureExpression child) {
            List<Object> parameters = new ArrayList<>();
            if (child.getParameters() != null) {
                for (Parameter parameter : child.getParameters()) {
                    parameters.add(mapOf(
                            "name", parameter.getName(),
                            "type", parameter.getType().getName(),
                            "default", parameter.hasInitialExpression()
                                    ? expression(parameter.getInitialExpression())
                                    : null));
                }
            }
            return nodeMap(node, "closure",
                    "parameters", parameters,
                    "parameterSpecified", child.isParameterSpecified(),
                    "body", statement(child.getCode()));
        }
        if (node instanceof GStringExpression child) {
            List<Object> strings = new ArrayList<>();
            for (ConstantExpression string : child.getStrings()) {
                strings.add(string.getValue());
            }
            return nodeMap(node, "gstring",
                    "strings", strings,
                    "values", expressions(child.getValues()));
        }
        if (node instanceof ElvisOperatorExpression child) {
            return nodeMap(node, "elvis",
                    "boolean", expression(child.getBooleanExpression().getExpression()),
                    "false", expression(child.getFalseExpression()));
        }
        if (node instanceof TernaryExpression child) {
            return nodeMap(node, "ternary",
                    "condition", expression(child.getBooleanExpression().getExpression()),
                    "true", expression(child.getTrueExpression()),
                    "false", expression(child.getFalseExpression()));
        }
        if (node instanceof NotExpression child) {
            return nodeMap(node, "not", "value", expression(child.getExpression()));
        }
        if (node instanceof BooleanExpression child) {
            return nodeMap(node, "boolean", "value", expression(child.getExpression()));
        }
        if (node instanceof UnaryMinusExpression child) {
            return nodeMap(node, "unaryMinus", "value", expression(child.getExpression()));
        }
        if (node instanceof UnaryPlusExpression child) {
            return nodeMap(node, "unaryPlus", "value", expression(child.getExpression()));
        }
        if (node instanceof BitwiseNegationExpression child) {
            return nodeMap(node, "bitwiseNegation", "value", expression(child.getExpression()));
        }
        if (node instanceof PrefixExpression child) {
            return nodeMap(node, "prefix",
                    "operator", child.getOperation().getText(),
                    "value", expression(child.getExpression()));
        }
        if (node instanceof PostfixExpression child) {
            return nodeMap(node, "postfix",
                    "operator", child.getOperation().getText(),
                    "value", expression(child.getExpression()));
        }
        if (node instanceof CastExpression child) {
            return nodeMap(node, "cast",
                    "type", child.getType().getName(),
                    "value", expression(child.getExpression()));
        }
        if (node instanceof ArrayExpression child) {
            return nodeMap(node, "array",
                    "elementType", child.getElementType().getName(),
                    "sizes", child.getSizeExpression() == null ? List.of() : expressions(child.getSizeExpression()),
                    "items", child.getExpressions() == null ? List.of() : expressions(child.getExpressions()));
        }
        if (node instanceof ClassExpression child) {
            return nodeMap(node, "classExpression", "type", child.getType().getName());
        }
        if (node instanceof ArgumentListExpression child) {
            return nodeMap(node, "arguments", "items", expressions(child.getExpressions()));
        }
        if (node instanceof TupleExpression child) {
            return nodeMap(node, "tuple", "items", expressions(child.getExpressions()));
        }
        if (node instanceof ClosureListExpression child) {
            return nodeMap(node, "closureList", "items", expressions(child.getExpressions()));
        }
        if (node instanceof SpreadExpression child) {
            return nodeMap(node, "spread", "value", expression(child.getExpression()));
        }
        if (node instanceof SpreadMapExpression child) {
            return nodeMap(node, "spreadMap", "value", expression(child.getExpression()));
        }
        if (node instanceof MethodPointerExpression child) {
            return nodeMap(node, "methodPointer",
                    "object", expression(child.getExpression()),
                    "method", expression(child.getMethodName()));
        }
        if (node instanceof FieldExpression child) {
            return nodeMap(node, "field", "name", child.getField().getName());
        }
        return nodeMap(node, "unsupportedExpression", "groovyType", node.getClass().getName());
    }

    private List<Object> expressions(List<? extends Expression> nodes) {
        List<Object> result = new ArrayList<>();
        for (Expression node : nodes) {
            result.add(expression(node));
        }
        return result;
    }

    private Map<String, Object> nodeMap(ASTNode node, String kind, Object... values) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("kind", kind);
        result.put("span", span(node));
        for (int index = 0; index < values.length; index += 2) {
            result.put((String) values[index], values[index + 1]);
        }
        return result;
    }

    private Map<String, Object> span(ASTNode node) {
        if (node.getLineNumber() <= 0 || node.getLastLineNumber() <= 0) {
            return null;
        }
        int startLine = node.getLineNumber() - lineOffset;
        int endLine = node.getLastLineNumber() - lineOffset;
        if (endLine < 1) {
            return null;
        }
        return mapOf(
                "line", Math.max(1, startLine),
                "column", Math.max(1, node.getColumnNumber()),
                "endLine", Math.max(1, endLine),
                "endColumn", Math.max(1, node.getLastColumnNumber()));
    }

    private static Map<String, Object> diagnostic(String code, String message) {
        return mapOf("code", code, "message", message == null ? "Unknown Groovy parser error" : message);
    }

    private static Map<String, Object> mapOf(Object... values) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (int index = 0; index < values.length; index += 2) {
            result.put((String) values[index], values[index + 1]);
        }
        return result;
    }
}
